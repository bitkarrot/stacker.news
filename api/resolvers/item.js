import { UserInputError, AuthenticationError } from 'apollo-server-micro'
import { ensureProtocol } from '../../lib/url'
import serialize from './serial'
import { decodeCursor, LIMIT, nextCursorEncoded } from '../../lib/cursor'
import { getMetadata, metadataRuleSets } from 'page-metadata-parser'
import domino from 'domino'
import { BOOST_MIN } from '../../lib/constants'

async function comments (models, id, sort) {
  let orderBy
  let join
  switch (sort) {
    case 'top':
      orderBy = 'ORDER BY x.sats DESC NULLS LAST'
      join = COMMENTS_LEFT_JOIN_WEIGHTED_SATS
      break
    case 'recent':
      orderBy = 'ORDER BY "Item".created_at DESC'
      join = ''
      break
    default:
      orderBy = COMMENTS_ORDER_BY_SATS
      join = COMMENTS_LEFT_JOIN_WEIGHTED_SATS
      break
  }

  const flat = await models.$queryRaw(`
        WITH RECURSIVE base AS (
          ${SELECT}, ARRAY[row_number() OVER (${orderBy}, "Item".path)] AS sort_path
          FROM "Item"
          ${join}
          WHERE "parentId" = $1
        UNION ALL
          ${SELECT}, p.sort_path || row_number() OVER (${orderBy}, "Item".path)
          FROM base p
          JOIN "Item" ON "Item"."parentId" = p.id
          ${join})
        SELECT * FROM base ORDER BY sort_path`, Number(id))
  return nestComments(flat, id)[0]
}

const COMMENTS_LEFT_JOIN_WEIGHTED_SATS_SELECT = 'SELECT "Item".id, SUM(CASE WHEN "ItemAct".act = \'VOTE\' AND "Item"."userId" <> "ItemAct"."userId" THEN users.trust ELSE 0 END) as sats'
const COMMENTS_LEFT_JOIN_WEIGHTED_SATS =
  `LEFT JOIN LATERAL (
    ${COMMENTS_LEFT_JOIN_WEIGHTED_SATS_SELECT}
    FROM "ItemAct"
    JOIN users on "ItemAct"."userId" = users.id
    WHERE "Item".id = "ItemAct"."itemId"
    GROUP BY "Item".id
  ) x ON "Item".id = x.id`
const COMMENTS_ORDER_BY_SATS =
  'ORDER BY GREATEST(x.sats, 0)/POWER(EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE \'UTC\') - "Item".created_at))/3600+2, 1.3) DESC NULLS LAST, "Item".id DESC'

export async function getItem (parent, { id }, { models }) {
  const [item] = await models.$queryRaw(`
  ${SELECT}
  FROM "Item"
  WHERE id = $1`, Number(id))
  return item
}

function topClause (within) {
  let interval = ' AND "Item".created_at >= $1 - INTERVAL '
  switch (within) {
    case 'day':
      interval += "'1 day'"
      break
    case 'week':
      interval += "'7 days'"
      break
    case 'month':
      interval += "'1 month'"
      break
    case 'year':
      interval += "'1 year'"
      break
    default:
      interval = ''
      break
  }
  return interval
}

export default {
  Query: {
    items: async (parent, { sub, sort, cursor, name, within }, { me, models }) => {
      const decodedCursor = decodeCursor(cursor)
      let items; let user; let pins; let subFull

      const subClause = (num) => {
        return sub ? ` AND "subName" = $${num} ` : ` AND ("subName" IS NULL OR "subName" = $${num}) `
      }

      const activeOrMine = () => {
        return me ? ` AND (status = 'ACTIVE' OR "userId" = ${me.id}) ` : ' AND status = \'ACTIVE\' '
      }

      switch (sort) {
        case 'user':
          if (!name) {
            throw new UserInputError('must supply name', { argumentName: 'name' })
          }

          user = await models.user.findUnique({ where: { name } })
          if (!user) {
            throw new UserInputError('no user has that name', { argumentName: 'name' })
          }

          items = await models.$queryRaw(`
            ${SELECT}
            FROM "Item"
            WHERE "userId" = $1 AND "parentId" IS NULL AND created_at <= $2
            AND "pinId" IS NULL
            ${activeOrMine()}
            ORDER BY created_at DESC
            OFFSET $3
            LIMIT ${LIMIT}`, user.id, decodedCursor.time, decodedCursor.offset)
          break
        case 'recent':
          items = await models.$queryRaw(`
            ${SELECT}
            FROM "Item"
            WHERE "parentId" IS NULL AND created_at <= $1
            ${subClause(3)}
            ${activeOrMine()}
            ORDER BY created_at DESC
            OFFSET $2
            LIMIT ${LIMIT}`, decodedCursor.time, decodedCursor.offset, sub || 'NULL')
          break
        case 'top':
          items = await models.$queryRaw(`
            ${SELECT}
            FROM "Item"
            ${newTimedLeftJoinWeightedSats(1)}
            WHERE "parentId" IS NULL AND "Item".created_at <= $1
            AND "pinId" IS NULL
            ${topClause(within)}
            ${TOP_ORDER_BY_SATS}
            OFFSET $2
            LIMIT ${LIMIT}`, decodedCursor.time, decodedCursor.offset)
          break
        default:
          // sub so we know the default ranking
          if (sub) {
            subFull = await models.sub.findUnique({ where: { name: sub } })
          }

          switch (subFull?.rankingType) {
            case 'AUCTION':
              // it might be sufficient to sort by the floor(maxBid / 1000) desc, created_at desc
              // we pull from their wallet
              // TODO: need to filter out by payment status
              items = await models.$queryRaw(`
                ${SELECT}
                FROM "Item"
                WHERE "parentId" IS NULL AND created_at <= $1
                AND "pinId" IS NULL
                ${subClause(3)}
                AND status = 'ACTIVE'
                ORDER BY "maxBid" DESC, created_at ASC
                OFFSET $2
                LIMIT ${LIMIT}`, decodedCursor.time, decodedCursor.offset, sub)
              break
            default:
              // HACK we can speed hack the first hot page, by limiting our query to only
              // the most recently created items so that the tables doesn't have to
              // fully be computed
              // if the offset is 0, we limit our search to posts from the last week
              // if there are 21 items, return them ... if not do the unrestricted query
              // instead of doing this we should materialize a view ... but this is easier for now
              if (decodedCursor.offset === 0) {
                items = await models.$queryRaw(`
                  ${SELECT}
                  FROM "Item"
                  ${newTimedLeftJoinWeightedSats(1)}
                  WHERE "parentId" IS NULL AND "Item".created_at <= $1 AND "Item".created_at > $3
                  AND "pinId" IS NULL
                  ${subClause(4)}
                  ${newTimedOrderByWeightedSats(1)}
                  OFFSET $2
                  LIMIT ${LIMIT}`, decodedCursor.time, decodedCursor.offset, new Date(new Date().setDate(new Date().getDate() - 5)), sub || 'NULL')
              }

              if (decodedCursor.offset !== 0 || items?.length < LIMIT) {
                items = await models.$queryRaw(`
                  ${SELECT}
                  FROM "Item"
                  ${newTimedLeftJoinWeightedSats(1)}
                  WHERE "parentId" IS NULL AND "Item".created_at <= $1
                  AND "pinId" IS NULL
                  ${subClause(3)}
                  ${newTimedOrderByWeightedSats(1)}
                  OFFSET $2
                  LIMIT ${LIMIT}`, decodedCursor.time, decodedCursor.offset, sub || 'NULL')
              }

              if (decodedCursor.offset === 0) {
                // get pins for the page and return those separately
                pins = await models.$queryRaw(`SELECT rank_filter.*
                  FROM (
                    ${SELECT},
                    rank() OVER (
                        PARTITION BY "pinId"
                        ORDER BY created_at DESC
                    )
                    FROM "Item"
                    WHERE "pinId" IS NOT NULL
                ) rank_filter WHERE RANK = 1`)
              }
              break
          }
          break
      }
      return {
        cursor: items.length === LIMIT ? nextCursorEncoded(decodedCursor) : null,
        items,
        pins
      }
    },
    allItems: async (parent, { cursor }, { models }) => {
      const decodedCursor = decodeCursor(cursor)
      const items = await models.$queryRaw(`
        ${SELECT}
        FROM "Item"
        ORDER BY created_at DESC
        OFFSET $1
        LIMIT ${LIMIT}`, decodedCursor.offset)
      return {
        cursor: items.length === LIMIT ? nextCursorEncoded(decodedCursor) : null,
        items
      }
    },
    moreFlatComments: async (parent, { cursor, name, sort, within }, { me, models }) => {
      const decodedCursor = decodeCursor(cursor)

      let comments, user
      switch (sort) {
        case 'user':
          if (!name) {
            throw new UserInputError('must supply name', { argumentName: 'name' })
          }

          user = await models.user.findUnique({ where: { name } })
          if (!user) {
            throw new UserInputError('no user has that name', { argumentName: 'name' })
          }

          comments = await models.$queryRaw(`
            ${SELECT}
            FROM "Item"
            WHERE "userId" = $1 AND "parentId" IS NOT NULL
            AND created_at <= $2
            ORDER BY created_at DESC
            OFFSET $3
            LIMIT ${LIMIT}`, user.id, decodedCursor.time, decodedCursor.offset)
          break
        case 'top':
          comments = await models.$queryRaw(`
          ${SELECT}
          FROM "Item"
          ${newTimedLeftJoinWeightedSats(1)}
          WHERE "parentId" IS NOT NULL
          AND "Item".created_at <= $1
          ${topClause(within)}
          ${TOP_ORDER_BY_SATS}
          OFFSET $2
          LIMIT ${LIMIT}`, decodedCursor.time, decodedCursor.offset)
          break
        default:
          throw new UserInputError('invalid sort type', { argumentName: 'sort' })
      }

      return {
        cursor: comments.length === LIMIT ? nextCursorEncoded(decodedCursor) : null,
        comments
      }
    },
    item: getItem,
    pageTitle: async (parent, { url }, { models }) => {
      try {
        const response = await fetch(ensureProtocol(url), { redirect: 'follow' })
        const html = await response.text()
        const doc = domino.createWindow(html).document
        const metadata = getMetadata(doc, url, { title: metadataRuleSets.title })
        return metadata?.title
      } catch (e) {
        return null
      }
    },
    dupes: async (parent, { url }, { models }) => {
      const urlObj = new URL(ensureProtocol(url))
      let uri = urlObj.hostname + urlObj.pathname
      uri = uri.endsWith('/') ? uri.slice(0, -1) : uri
      let similar = `(http(s)?://)?${uri}/?`

      const whitelist = ['news.ycombinator.com/item', 'bitcointalk.org/index.php']
      const youtube = ['www.youtube.com', 'youtu.be']
      if (whitelist.includes(uri)) {
        similar += `\\${urlObj.search}`
      } else if (youtube.includes(urlObj.hostname)) {
        // extract id and create both links
        const matches = url.match(/(https?:\/\/)?((www\.)?(youtube(-nocookie)?|youtube.googleapis)\.com.*(v\/|v=|vi=|vi\/|e\/|embed\/|user\/.*\/u\/\d+\/)|youtu\.be\/)(?<id>[_0-9a-z-]+)/i)
        similar = `(http(s)?://)?(www.youtube.com/watch\\?v=${matches?.groups?.id}|youtu.be/${matches?.groups?.id})`
      } else {
        similar += '(\\?%)?'
      }

      return await models.$queryRaw(`
        ${SELECT}
        FROM "Item"
        WHERE url SIMILAR TO $1
        ORDER BY created_at DESC
        LIMIT 3`, similar)
    },
    comments: async (parent, { id, sort }, { models }) => {
      return comments(models, id, sort)
    },
    search: async (parent, { q: query, sub, cursor }, { me, models, search }) => {
      const decodedCursor = decodeCursor(cursor)
      let sitems

      try {
        sitems = await search.search({
          index: 'item',
          size: LIMIT,
          from: decodedCursor.offset,
          body: {
            query: {
              bool: {
                must: [
                  sub
                    ? { match: { 'sub.name': sub } }
                    : { bool: { must_not: { exists: { field: 'sub.name' } } } },
                  me
                    ? {
                        bool: {
                          should: [
                            { match: { status: 'ACTIVE' } },
                            { match: { userId: me.id } }
                          ]
                        }
                      }
                    : { match: { status: 'ACTIVE' } },
                  {
                    bool: {
                      should: [
                        {
                        // all terms are matched in fields
                          multi_match: {
                            query,
                            type: 'most_fields',
                            fields: ['title^20', 'text'],
                            minimum_should_match: '100%',
                            boost: 400
                          }
                        },
                        {
                          // all terms are matched in fields
                          multi_match: {
                            query,
                            type: 'most_fields',
                            fields: ['title^20', 'text'],
                            fuzziness: 'AUTO',
                            prefix_length: 3,
                            minimum_should_match: '100%',
                            boost: 20
                          }
                        },
                        {
                          // only some terms must match
                          multi_match: {
                            query,
                            type: 'most_fields',
                            fields: ['title^20', 'text'],
                            fuzziness: 'AUTO',
                            prefix_length: 3,
                            minimum_should_match: '60%'
                          }
                        }
                        // TODO: add wildcard matches for
                        // user.name and url
                      ]
                    }
                  }
                ],
                filter: {
                  range: {
                    createdAt: {
                      lte: decodedCursor.time
                    }
                  }
                }
              }
            },
            highlight: {
              fields: {
                title: { number_of_fragments: 0, pre_tags: [':high['], post_tags: [']'] },
                text: { number_of_fragments: 0, pre_tags: [':high['], post_tags: [']'] }
              }
            }
          }
        })
      } catch (e) {
        console.log(e)
        return {
          cursor: null,
          items: []
        }
      }

      // return highlights
      const items = sitems.body.hits.hits.map(e => {
        const item = e._source

        item.searchTitle = (e.highlight.title && e.highlight.title[0]) || item.title
        item.searchText = (e.highlight.text && e.highlight.text[0]) || item.text

        return item
      })

      return {
        cursor: items.length === LIMIT ? nextCursorEncoded(decodedCursor) : null,
        items
      }
    },
    auctionPosition: async (parent, { id, sub, bid }, { models }) => {
      // count items that have a bid gte to the current bid or
      // gte current bid and older
      const where = {
        where: {
          subName: sub,
          status: 'ACTIVE',
          maxBid: {
            gte: bid
          }
        }
      }

      if (id) {
        where.where.id = { not: Number(id) }
      }

      return await models.item.count(where) + 1
    }
  },

  Mutation: {
    upsertLink: async (parent, args, { me, models }) => {
      const { id, ...data } = args
      data.url = ensureProtocol(data.url)

      if (id) {
        const { forward, boost, ...remaining } = data
        return await updateItem(parent, { id, data: remaining }, { me, models })
      } else {
        return await createItem(parent, data, { me, models })
      }
    },
    upsertDiscussion: async (parent, args, { me, models }) => {
      const { id, ...data } = args

      if (id) {
        const { forward, boost, ...remaining } = data
        return await updateItem(parent, { id, data: remaining }, { me, models })
      } else {
        return await createItem(parent, data, { me, models })
      }
    },
    upsertJob: async (parent, { id, sub, title, company, location, remote, text, url, maxBid, status }, { me, models }) => {
      if (!me) {
        throw new AuthenticationError('you must be logged in to create job')
      }

      const fullSub = await models.sub.findUnique({ where: { name: sub } })
      if (!fullSub) {
        throw new UserInputError('not a valid sub', { argumentName: 'sub' })
      }

      if (fullSub.baseCost > maxBid) {
        throw new UserInputError(`bid must be at least ${fullSub.baseCost}`, { argumentName: 'maxBid' })
      }

      if (!location && !remote) {
        throw new UserInputError('must specify location or remote', { argumentName: 'location' })
      }

      const checkSats = async () => {
        // check if the user has the funds to run for the first minute
        const minuteMsats = maxBid * 1000
        const user = await models.user.findUnique({ where: { id: me.id } })
        if (user.msats < minuteMsats) {
          throw new UserInputError('insufficient funds')
        }
      }

      const data = {
        title,
        company,
        location: location.toLowerCase() === 'remote' ? undefined : location,
        remote,
        text,
        url,
        maxBid,
        subName: sub,
        userId: me.id
      }

      if (id) {
        if (status) {
          data.status = status

          // if the job is changing to active, we need to check they have funds
          if (status === 'ACTIVE') {
            await checkSats()
          }
        }

        const old = await models.item.findUnique({ where: { id: Number(id) } })
        if (Number(old.userId) !== Number(me?.id)) {
          throw new AuthenticationError('item does not belong to you')
        }

        return await models.item.update({
          where: { id: Number(id) },
          data
        })
      }

      // before creating job, check the sats
      await checkSats()
      return await models.item.create({
        data
      })
    },
    createComment: async (parent, { text, parentId }, { me, models }) => {
      return await createItem(parent, { text, parentId }, { me, models })
    },
    updateComment: async (parent, { id, text }, { me, models }) => {
      return await updateItem(parent, { id, data: { text } }, { me, models })
    },
    act: async (parent, { id, sats }, { me, models }) => {
      // need to make sure we are logged in
      if (!me) {
        throw new AuthenticationError('you must be logged in')
      }

      if (sats <= 0) {
        throw new UserInputError('sats must be positive', { argumentName: 'sats' })
      }

      // disallow self tips
      const [item] = await models.$queryRaw(`
      ${SELECT}
      FROM "Item"
      WHERE id = $1 AND "userId" = $2`, Number(id), me.id)
      if (item) {
        throw new UserInputError('cannot tip your self')
      }

      const [{ item_act: vote }] = await serialize(models, models.$queryRaw`SELECT item_act(${Number(id)}, ${me.id}, 'TIP', ${Number(sats)})`)

      return {
        vote,
        sats
      }
    }
  },

  Item: {
    sub: async (item, args, { models }) => {
      if (!item.subName) {
        return null
      }

      return await models.sub.findUnique({ where: { name: item.subName } })
    },
    position: async (item, args, { models }) => {
      if (!item.pinId) {
        return null
      }

      const pin = await models.pin.findUnique({ where: { id: item.pinId } })
      if (!pin) {
        return null
      }

      return pin.position
    },
    prior: async (item, args, { models }) => {
      if (!item.pinId) {
        return null
      }

      const prior = await models.item.findFirst({
        where: {
          pinId: item.pinId,
          createdAt: {
            lt: item.createdAt
          }
        },
        orderBy: {
          createdAt: 'desc'
        }
      })

      if (!prior) {
        return null
      }

      return prior.id
    },
    user: async (item, args, { models }) =>
      await models.user.findUnique({ where: { id: item.userId } }),
    fwdUser: async (item, args, { models }) => {
      if (!item.fwdUserId) {
        return null
      }
      return await models.user.findUnique({ where: { id: item.fwdUserId } })
    },
    ncomments: async (item, args, { models }) => {
      const [{ count }] = await models.$queryRaw`
        SELECT count(*)
        FROM "Item"
        WHERE path <@ text2ltree(${item.path}) AND id != ${Number(item.id)}`
      return count || 0
    },
    comments: async (item, args, { models }) => {
      if (item.comments) {
        return item.comments
      }
      return comments(models, item.id, 'hot')
    },
    sats: async (item, args, { models }) => {
      const { sum: { sats } } = await models.itemAct.aggregate({
        sum: {
          sats: true
        },
        where: {
          itemId: Number(item.id),
          userId: {
            not: Number(item.userId)
          },
          act: {
            not: 'BOOST'
          }
        }
      })

      return sats || 0
    },
    upvotes: async (item, args, { models }) => {
      const { sum: { sats } } = await models.itemAct.aggregate({
        sum: {
          sats: true
        },
        where: {
          itemId: Number(item.id),
          userId: {
            not: Number(item.userId)
          },
          act: 'VOTE'
        }
      })

      return sats || 0
    },
    boost: async (item, args, { models }) => {
      const { sum: { sats } } = await models.itemAct.aggregate({
        sum: {
          sats: true
        },
        where: {
          itemId: Number(item.id),
          act: 'BOOST'
        }
      })

      return sats || 0
    },
    meSats: async (item, args, { me, models }) => {
      if (!me) return 0

      const { sum: { sats } } = await models.itemAct.aggregate({
        sum: {
          sats: true
        },
        where: {
          itemId: Number(item.id),
          userId: me.id,
          OR: [
            {
              act: 'TIP'
            },
            {
              act: 'VOTE'
            }
          ]
        }
      })

      return sats || 0
    },
    meComments: async (item, args, { me, models }) => {
      if (!me) return 0

      return await models.item.count({ where: { userId: me.id, parentId: item.id } })
    },
    mine: async (item, args, { me, models }) => {
      return me?.id === item.userId
    },
    root: async (item, args, { models }) => {
      if (!item.parentId) {
        return null
      }
      return (await models.$queryRaw(`
        ${SELECT}
        FROM "Item"
        WHERE id = (
          SELECT ltree2text(subltree(path, 0, 1))::integer
          FROM "Item"
          WHERE id = $1)`, Number(item.id)))[0]
    },
    parent: async (item, args, { models }) => {
      if (!item.parentId) {
        return null
      }
      return await models.item.findUnique({ where: { id: item.parentId } })
    }
  }
}

const namePattern = /\B@[\w_]+/gi

export const createMentions = async (item, models) => {
  // if we miss a mention, in the rare circumstance there's some kind of
  // failure, it's not a big deal so we don't do it transactionally
  // ideally, we probably would
  if (!item.text) {
    return
  }

  try {
    const mentions = item.text.match(namePattern)?.map(m => m.slice(1))
    if (mentions?.length > 0) {
      const users = await models.user.findMany({
        where: {
          name: { in: mentions }
        }
      })

      users.forEach(async user => {
        const data = {
          itemId: item.id,
          userId: user.id
        }

        await models.mention.upsert({
          where: {
            itemId_userId: data
          },
          update: data,
          create: data
        })
      })
    }
  } catch (e) {
    console.log('mention failure', e)
  }
}

const updateItem = async (parent, { id, data }, { me, models }) => {
  // update iff this item belongs to me
  const old = await models.item.findUnique({ where: { id: Number(id) } })
  if (Number(old.userId) !== Number(me?.id)) {
    throw new AuthenticationError('item does not belong to you')
  }

  // if it's not the FAQ and older than 10 minutes
  if (old.id !== 349 && Date.now() > new Date(old.createdAt).getTime() + 10 * 60000) {
    throw new UserInputError('item can no longer be editted')
  }

  const item = await models.item.update({
    where: { id: Number(id) },
    data
  })

  await createMentions(item, models)

  return item
}

const createItem = async (parent, { title, url, text, boost, forward, parentId }, { me, models }) => {
  if (!me) {
    throw new AuthenticationError('you must be logged in')
  }

  if (boost && boost < BOOST_MIN) {
    throw new UserInputError(`boost must be at least ${BOOST_MIN}`, { argumentName: 'boost' })
  }

  let fwdUser
  if (forward) {
    fwdUser = await models.user.findUnique({ where: { name: forward } })
    if (!fwdUser) {
      throw new UserInputError('forward user does not exist', { argumentName: 'forward' })
    }
  }

  const [item] = await serialize(models,
    models.$queryRaw(`${SELECT} FROM create_item($1, $2, $3, $4, $5, $6) AS "Item"`,
      title, url, text, Number(boost || 0), Number(parentId), Number(me.id)))

  await createMentions(item, models)

  if (fwdUser) {
    await models.item.update({
      where: { id: item.id },
      data: {
        fwdUserId: fwdUser.id
      }
    })
  }

  item.comments = []
  return item
}

function nestComments (flat, parentId) {
  const result = []
  let added = 0
  for (let i = 0; i < flat.length;) {
    if (!flat[i].comments) flat[i].comments = []
    if (Number(flat[i].parentId) === Number(parentId)) {
      result.push(flat[i])
      added++
      i++
    } else if (result.length > 0) {
      const item = result[result.length - 1]
      const [nested, newAdded] = nestComments(flat.slice(i), item.id)
      if (newAdded === 0) {
        break
      }
      item.comments.push(...nested)
      i += newAdded
      added += newAdded
    } else {
      break
    }
  }
  return [result, added]
}

// we have to do our own query because ltree is unsupported
export const SELECT =
  `SELECT "Item".id, "Item".created_at as "createdAt", "Item".updated_at as "updatedAt", "Item".title,
  "Item".text, "Item".url, "Item"."userId", "Item"."fwdUserId", "Item"."parentId", "Item"."pinId", "Item"."maxBid",
  "Item".company, "Item".location, "Item".remote,
  "Item"."subName", "Item".status, ltree2text("Item"."path") AS "path"`

function newTimedLeftJoinWeightedSats (num) {
  return `
   LEFT JOIN "ItemAct" ON "Item".id = "ItemAct"."itemId" AND "ItemAct".created_at <= $${num}
   JOIN users ON "ItemAct"."userId" = users.id`
}

function newTimedOrderByWeightedSats (num) {
  return `
    GROUP BY "Item".id
    ORDER BY (SUM(CASE WHEN "ItemAct".act = 'VOTE' AND "Item"."userId" <> "ItemAct"."userId" THEN users.trust ELSE 0 END)/POWER(EXTRACT(EPOCH FROM ($${num} - "Item".created_at))/3600+2, 1.3) +
              GREATEST(SUM(CASE WHEN "ItemAct".act = 'BOOST' THEN "ItemAct".sats ELSE 0 END)-1000+5, 0)/POWER(EXTRACT(EPOCH FROM ($${num} - "Item".created_at))/3600+2, 4)) DESC NULLS LAST, "Item".id DESC`
}

const TOP_ORDER_BY_SATS = 'GROUP BY "Item".id ORDER BY (SUM(CASE WHEN "ItemAct".act = \'VOTE\' AND "Item"."userId" <> "ItemAct"."userId" THEN users.trust ELSE 0 END)) DESC NULLS LAST, "Item".created_at DESC'
