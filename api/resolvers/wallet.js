import { createInvoice, decodePaymentRequest, payViaPaymentRequest } from 'ln-service'
import { UserInputError, AuthenticationError } from 'apollo-server-micro'
import serialize from './serial'
import { decodeCursor, LIMIT, nextCursorEncoded } from '../../lib/cursor'
import lnpr from 'bolt11'
import { SELECT } from './item'

export async function getInvoice (parent, { id }, { me, models }) {
  if (!me) {
    throw new AuthenticationError('you must be logged in')
  }

  const inv = await models.invoice.findUnique({
    where: {
      id: Number(id)
    },
    include: {
      user: true
    }
  })

  if (inv.user.id !== me.id) {
    throw new AuthenticationError('not ur invoice')
  }

  return inv
}

export default {
  Query: {
    invoice: getInvoice,
    withdrawl: async (parent, { id }, { me, models, lnd }) => {
      if (!me) {
        throw new AuthenticationError('you must be logged in')
      }

      const wdrwl = await models.withdrawl.findUnique({
        where: {
          id: Number(id)
        },
        include: {
          user: true
        }
      })

      if (wdrwl.user.id !== me.id) {
        throw new AuthenticationError('not ur withdrawal')
      }

      return wdrwl
    },
    connectAddress: async (parent, args, { lnd }) => {
      return process.env.LND_CONNECT_ADDRESS
    },
    walletHistory: async (parent, { cursor, inc }, { me, models, lnd }) => {
      const decodedCursor = decodeCursor(cursor)
      if (!me) {
        throw new AuthenticationError('you must be logged in')
      }

      const include = new Set(inc?.split(','))
      const queries = []

      if (include.has('invoice')) {
        queries.push(
          `(SELECT ('invoice' || id) as id, id as "factId", bolt11, created_at as "createdAt",
          COALESCE("msatsReceived", "msatsRequested") as msats, NULL as "msatsFee",
          CASE WHEN "confirmedAt" IS NOT NULL THEN 'CONFIRMED'
              WHEN "expiresAt" <= $2 THEN 'EXPIRED'
              WHEN cancelled THEN 'CANCELLED'
              ELSE 'PENDING' END as status,
          'invoice' as type
          FROM "Invoice"
          WHERE "userId" = $1
            AND created_at <= $2)`)
      }

      if (include.has('withdrawal')) {
        queries.push(
          `(SELECT ('withdrawal' || id) as id, id as "factId", bolt11, created_at as "createdAt",
          CASE WHEN status = 'CONFIRMED' THEN "msatsPaid"
          ELSE "msatsPaying" END as msats,
          CASE WHEN status = 'CONFIRMED' THEN "msatsFeePaid"
          ELSE "msatsFeePaying" END as "msatsFee",
          COALESCE(status::text, 'PENDING') as status,
          'withdrawal' as type
          FROM "Withdrawl"
          WHERE "userId" = $1
            AND created_at <= $2)`)
      }

      if (include.has('stacked')) {
        queries.push(
          `(SELECT ('stacked' || "Item".id) as id, "Item".id as "factId", NULL as bolt11,
          MAX("ItemAct".created_at) as "createdAt", sum("ItemAct".sats) * 1000 as msats,
          0 as "msatsFee", NULL as status, 'stacked' as type
          FROM "ItemAct"
          JOIN "Item" on "ItemAct"."itemId" = "Item".id
          WHERE "ItemAct"."userId" <> $1 AND "ItemAct".act <> 'BOOST'
          AND (("Item"."userId" = $1 AND "Item"."fwdUserId" IS NULL)
                OR ("Item"."fwdUserId" = $1 AND "ItemAct"."userId" <> "Item"."userId"))
          AND "ItemAct".created_at <= $2
          GROUP BY "Item".id)`)
        queries.push(
            `(SELECT ('earn' || "Earn".id) as id, "Earn".id as "factId", NULL as bolt11,
            created_at as "createdAt", msats,
            0 as "msatsFee", NULL as status, 'earn' as type
            FROM "Earn"
            WHERE "Earn"."userId" = $1 AND "Earn".created_at <= $2)`)
      }

      if (include.has('spent')) {
        queries.push(
          `(SELECT ('spent' || "Item".id) as id, "Item".id as "factId", NULL as bolt11,
          MAX("ItemAct".created_at) as "createdAt", sum("ItemAct".sats) * 1000 as msats,
          0 as "msatsFee", NULL as status, 'spent' as type
          FROM "ItemAct"
          JOIN "Item" on "ItemAct"."itemId" = "Item".id
          WHERE "ItemAct"."userId" = $1
          AND "ItemAct".created_at <= $2
          GROUP BY "Item".id)`)
      }

      if (queries.length === 0) {
        return {
          cursor: null,
          facts: []
        }
      }

      let history = await models.$queryRaw(`
      ${queries.join(' UNION ALL ')}
      ORDER BY "createdAt" DESC
      OFFSET $3
      LIMIT ${LIMIT}`, me.id, decodedCursor.time, decodedCursor.offset)

      history = history.map(f => {
        if (f.bolt11) {
          const inv = lnpr.decode(f.bolt11)
          if (inv) {
            const { tags } = inv
            for (const tag of tags) {
              if (tag.tagName === 'description') {
                f.description = tag.data
                break
              }
            }
          }
        }
        switch (f.type) {
          case 'withdrawal':
            f.msats = (-1 * f.msats) - f.msatsFee
            break
          case 'spent':
            f.msats *= -1
            break
          default:
            break
        }

        return f
      })

      return {
        cursor: history.length === LIMIT ? nextCursorEncoded(decodedCursor) : null,
        facts: history
      }
    }
  },

  Mutation: {
    createInvoice: async (parent, { amount }, { me, models, lnd }) => {
      if (!me) {
        throw new AuthenticationError('you must be logged in')
      }

      if (!amount || amount <= 0) {
        throw new UserInputError('amount must be positive', { argumentName: 'amount' })
      }

      const user = await models.user.findUnique({ where: { id: me.id } })

      // set expires at to 3 hours into future
      const expiresAt = new Date(new Date().setHours(new Date().getHours() + 3))
      const description = `${amount} sats for @${user.name} on stacker.news`
      try {
        const invoice = await createInvoice({
          description,
          lnd,
          tokens: amount,
          expires_at: expiresAt
        })

        const [inv] = await serialize(models,
          models.$queryRaw`SELECT * FROM create_invoice(${invoice.id}, ${invoice.request},
            ${expiresAt}, ${amount * 1000}, ${me.id})`)

        return inv
      } catch (error) {
        console.log(error)
        throw error
      }
    },
    createWithdrawl: createWithdrawal,
    sendToLnAddr: async (parent, { addr, amount, maxFee }, { me, models, lnd }) => {
      const [name, domain] = addr.split('@')
      let req
      try {
        req = await fetch(`https://${domain}/.well-known/lnurlp/${name}`)
      } catch (e) {
        throw new Error(`error initiating protocol with https://${domain}`)
      }

      const res1 = await req.json()
      if (res1.status === 'ERROR') {
        throw new Error(res1.reason)
      }

      const milliamount = amount * 1000
      // check that amount is within min and max sendable
      if (milliamount < res1.minSendable || milliamount > res1.maxSendable) {
        throw new UserInputError(
          `amount must be >= ${res1.minSendable / 1000} and <= ${res1.maxSendable / 1000}`,
          { argumentName: 'amount' })
      }

      // call callback with amount
      const res2 = await (await fetch(`${res1.callback}?amount=${milliamount}`)).json()
      if (res2.status === 'ERROR') {
        throw new Error(res2.reason)
      }

      // take pr and createWithdrawl
      return await createWithdrawal(parent, { invoice: res2.pr, maxFee }, { me, models, lnd })
    }
  },

  Withdrawl: {
    satsPaying: w => Math.floor(w.msatsPaying / 1000),
    satsPaid: w => Math.floor(w.msatsPaid / 1000),
    satsFeePaying: w => Math.floor(w.msatsFeePaying / 1000),
    satsFeePaid: w => Math.floor(w.msatsFeePaid / 1000)
  },

  Fact: {
    item: async (fact, args, { models }) => {
      if (fact.type !== 'spent' && fact.type !== 'stacked') {
        return null
      }
      const [item] = await models.$queryRaw(`
        ${SELECT}
        FROM "Item"
        WHERE id = $1`, Number(fact.factId))

      return item
    }
  }
}

async function createWithdrawal (parent, { invoice, maxFee }, { me, models, lnd }) {
  // decode invoice to get amount
  let decoded
  try {
    decoded = await decodePaymentRequest({ lnd, request: invoice })
  } catch (error) {
    console.log(error)
    throw new UserInputError('could not decode invoice')
  }

  if (!decoded.mtokens || Number(decoded.mtokens) <= 0) {
    throw new UserInputError('you must specify amount')
  }

  const msatsFee = Number(maxFee) * 1000

  const user = await models.user.findUnique({ where: { id: me.id } })

  // create withdrawl transactionally (id, bolt11, amount, fee)
  const [withdrawl] = await serialize(models,
    models.$queryRaw`SELECT * FROM create_withdrawl(${decoded.id}, ${invoice},
      ${Number(decoded.mtokens)}, ${msatsFee}, ${user.name})`)

  payViaPaymentRequest({
    lnd,
    request: invoice,
    // can't use max_fee_mtokens https://github.com/alexbosworth/ln-service/issues/141
    max_fee: Number(maxFee),
    pathfinding_timeout: 30000
  })

  return withdrawl
}
