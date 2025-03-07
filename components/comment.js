import itemStyles from './item.module.css'
import styles from './comment.module.css'
import Text from './text'
import Link from 'next/link'
import Reply from './reply'
import { useEffect, useRef, useState } from 'react'
import { timeSince } from '../lib/time'
import UpVote from './upvote'
import Eye from '../svgs/eye-fill.svg'
import EyeClose from '../svgs/eye-close-line.svg'
import { useRouter } from 'next/router'
import CommentEdit from './comment-edit'
import Countdown from './countdown'
import { NOFOLLOW_LIMIT } from '../lib/constants'
import { ignoreClick } from '../lib/clicks'

function Parent ({ item, rootText }) {
  const ParentFrag = () => (
    <>
      <span> \ </span>
      <Link href={`/items/${item.parentId}`} passHref>
        <a className='text-reset'>parent</a>
      </Link>
    </>
  )

  if (!item.root) {
    return <ParentFrag />
  }

  return (
    <>
      {Number(item.root.id) !== Number(item.parentId) && <ParentFrag />}
      <span> \ </span>
      <Link href={`/items/${item.root.id}`} passHref>
        <a className='text-reset'>{rootText || 'on:'} {item.root.title}</a>
      </Link>
    </>
  )
}

const truncateString = (string = '', maxLength = 140) =>
  string.length > maxLength
    ? `${string.substring(0, maxLength)} […]`
    : string

export function CommentFlat ({ item, ...props }) {
  const router = useRouter()
  return (
    <div
      className='clickToContext py-2'
      onClick={e => {
        if (ignoreClick(e)) {
          return
        }
        router.push({
          pathname: '/items/[id]',
          query: { id: item.root.id, commentId: item.id }
        }, `/items/${item.root.id}`)
      }}
    >
      <Comment item={item} {...props} />
    </div>
  )
}

export default function Comment ({
  item, children, replyOpen, includeParent,
  rootText, noComments, noReply, truncate
}) {
  const [edit, setEdit] = useState()
  const [collapse, setCollapse] = useState(false)
  const ref = useRef(null)
  const router = useRouter()
  const mine = item.mine
  const editThreshold = new Date(item.createdAt).getTime() + 10 * 60000
  const [canEdit, setCanEdit] =
    useState(mine && (Date.now() < editThreshold))

  useEffect(() => {
    if (Number(router.query.commentId) === Number(item.id)) {
      ref.current.scrollIntoView()
      ref.current.classList.add('flash-it')
      router.replace({
        pathname: router.pathname,
        query: { id: router.query.id }
      }, undefined, { scroll: false })
    }
    setCollapse(localStorage.getItem(`commentCollapse:${item.id}`))
  }, [item])

  const op = item.root.user.name === item.user.name

  return (
    <div
      ref={ref} className={includeParent ? '' : `${styles.comment} ${collapse ? styles.collapsed : ''}`}
    >
      <div className={`${itemStyles.item} ${styles.item}`}>
        <UpVote item={item} className={styles.upvote} />
        <div className={`${itemStyles.hunk} ${styles.hunk}`}>
          <div className='d-flex align-items-center'>
            <div className={`${itemStyles.other} ${styles.other}`}>
              <span title={`from ${item.upvotes} users (${item.meSats} from me)`}>{item.sats} sats</span>
              <span> \ </span>
              {item.boost > 0 &&
                <>
                  <span>{item.boost} boost</span>
                  <span> \ </span>
                </>}
              <Link href={`/items/${item.id}`} passHref>
                <a className='text-reset'>{item.ncomments} replies</a>
              </Link>
              <span> \ </span>
              <Link href={`/${item.user.name}`} passHref>
                <a>@{item.user.name}<span className='text-boost font-weight-bold'>{op && ' OP'}</span></a>
              </Link>
              <span> </span>
              <Link href={`/items/${item.id}`} passHref>
                <a title={item.createdAt} className='text-reset'>{timeSince(new Date(item.createdAt))}</a>
              </Link>
              {includeParent && <Parent item={item} rootText={rootText} />}
              {canEdit &&
                <>
                  <span> \ </span>
                  <div
                    className={styles.edit}
                    onClick={e => {
                      setEdit(!edit)
                    }}
                  >
                    {edit ? 'cancel' : 'edit'}
                    <Countdown
                      date={editThreshold}
                      onComplete={() => {
                        setCanEdit(false)
                      }}
                    />
                  </div>
                </>}
            </div>
            {!includeParent && (collapse
              ? <Eye
                  className={styles.collapser} height={10} width={10} onClick={() => {
                    setCollapse(false)
                    localStorage.removeItem(`commentCollapse:${item.id}`)
                  }}
                />
              : <EyeClose
                  className={styles.collapser} height={10} width={10} onClick={() => {
                    setCollapse(true)
                    localStorage.setItem(`commentCollapse:${item.id}`, 'yep')
                  }}
                />)}
          </div>
          {edit
            ? (
              <CommentEdit
                comment={item}
                onSuccess={() => {
                  setEdit(!edit)
                  setCanEdit(mine && (Date.now() < editThreshold))
                }}
              />
              )
            : (
              <div className={styles.text}>
                <Text nofollow={item.sats + item.boost < NOFOLLOW_LIMIT}>
                  {truncate ? truncateString(item.text) : item.searchText || item.text}
                </Text>
              </div>
              )}
        </div>
      </div>
      <div className={`${styles.children}`}>
        {!noReply &&
          <Reply
            parentId={item.id} meComments={item.meComments} replyOpen={replyOpen}
          />}
        {children}
        <div className={`${styles.comments} ml-sm-1 ml-md-3`}>
          {item.comments && !noComments
            ? item.comments.map((item) => (
              <Comment key={item.id} item={item} />
              ))
            : null}
        </div>
      </div>
    </div>
  )
}

export function CommentSkeleton ({ skeletonChildren }) {
  return (
    <div className={styles.comment}>
      <div className={`${itemStyles.item} ${itemStyles.skeleton} ${styles.item} ${styles.skeleton}`}>
        <UpVote className={styles.upvote} />
        <div className={`${itemStyles.hunk} ${styles.hunk}`}>
          <div className={itemStyles.other}>
            <span className={`${itemStyles.otherItem} clouds`} />
            <span className={`${itemStyles.otherItem} clouds`} />
            <span className={`${itemStyles.otherItem} clouds`} />
            <span className={`${itemStyles.otherItem} ${itemStyles.otherItemLonger} clouds`} />
          </div>
          <div className={`${styles.text} clouds`} />
        </div>
      </div>
      <div className={`${itemStyles.children} ${styles.children} ${styles.skeleton}`}>
        <div className={styles.replyPadder}>
          <div className={`${itemStyles.other} ${styles.reply} clouds`} />
        </div>
        <div className={`${styles.comments} ml-sm-1 ml-md-3`}>
          {skeletonChildren
            ? <CommentSkeleton skeletonChildren={skeletonChildren - 1} />
            : null}
        </div>
      </div>
    </div>
  )
}
