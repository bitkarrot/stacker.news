import Navbar from 'react-bootstrap/Navbar'
import Nav from 'react-bootstrap/Nav'
import Link from 'next/link'
import styles from './header.module.css'
import { useRouter } from 'next/router'
import { Button, Container, NavDropdown } from 'react-bootstrap'
import Price from './price'
import { useMe } from './me'
import Head from 'next/head'
import { signOut, signIn } from 'next-auth/client'
import { useLightning } from './lightning'
import { useEffect, useState } from 'react'
import { randInRange } from '../lib/rand'
import { formatSats } from '../lib/format'
import NoteIcon from '../svgs/notification-4-fill.svg'
import { useQuery, gql } from '@apollo/client'

function WalletSummary ({ me }) {
  if (!me) return null

  return `${formatSats(me.sats)}`
}

export default function Header ({ sub }) {
  const router = useRouter()
  const path = router.asPath.split('?')[0]
  const [fired, setFired] = useState()
  const me = useMe()
  const prefix = sub ? `/~${sub}` : ''
  const { data: subLatestPost } = useQuery(gql`
    query subLatestPost($name: ID!) {
      subLatestPost(name: $name)
    }
  `, { variables: { name: 'jobs' }, pollInterval: 600000, fetchPolicy: 'network-only' })

  const [lastCheckedJobs, setLastCheckedJobs] = useState(new Date().getTime())
  useEffect(() => {
    if (me) {
      setLastCheckedJobs(me.lastCheckedJobs)
    } else {
      if (sub === 'jobs') {
        localStorage.setItem('lastCheckedJobs', new Date().getTime())
      }
      setLastCheckedJobs(localStorage.getItem('lastCheckedJobs'))
    }
  })

  const Corner = () => {
    if (me) {
      return (
        <div className='d-flex align-items-center'>
          <Head>
            <link rel='shortcut icon' href={me?.hasNewNotes ? '/favicon-notify.png' : '/favicon.png'} />
          </Head>
          <Link href='/notifications' passHref>
            <Nav.Link className='pl-0 position-relative'>
              <NoteIcon />
              {me?.hasNewNotes &&
                <span className={styles.notification}>
                  <span className='invisible'>{' '}</span>
                </span>}
            </Nav.Link>
          </Link>
          <div className='position-relative'>
            <NavDropdown className={styles.dropdown} title={`@${me?.name}`} alignRight>
              <Link href={'/' + me?.name} passHref>
                <NavDropdown.Item>
                  profile
                  {me && !me.bioId &&
                    <div className='p-1 d-inline-block bg-secondary ml-1'>
                      <span className='invisible'>{' '}</span>
                    </div>}
                </NavDropdown.Item>
              </Link>
              <Link href='/wallet' passHref>
                <NavDropdown.Item>wallet</NavDropdown.Item>
              </Link>
              <Link href='/satistics?inc=invoice,withdrawal,stacked,spent' passHref>
                <NavDropdown.Item>satistics</NavDropdown.Item>
              </Link>
              <NavDropdown.Divider />
              <Link href='/invites' passHref>
                <NavDropdown.Item>invites
                  {me && !me.hasInvites &&
                    <div className='p-1 d-inline-block bg-success ml-1'>
                      <span className='invisible'>{' '}</span>
                    </div>}
                </NavDropdown.Item>
              </Link>
              <NavDropdown.Divider />
              <div className='d-flex align-items-center'>
                <Link href='/settings' passHref>
                  <NavDropdown.Item>settings</NavDropdown.Item>
                </Link>
              </div>
              <NavDropdown.Divider />
              <NavDropdown.Item onClick={() => signOut({ callbackUrl: '/' })}>logout</NavDropdown.Item>
            </NavDropdown>
            {me && !me.bioId &&
              <span className='position-absolute p-1 bg-secondary' style={{ top: '5px', right: '0px' }}>
                <span className='invisible'>{' '}</span>
              </span>}
          </div>
          {me &&
            <Nav.Item>
              <Link href='/wallet' passHref>
                <Nav.Link className='text-success px-0 text-nowrap'><WalletSummary me={me} /></Nav.Link>
              </Link>
            </Nav.Item>}
        </div>
      )
    } else {
      if (!fired) {
        const strike = useLightning()
        useEffect(() => {
          setTimeout(strike, randInRange(3000, 10000))
          setFired(true)
        }, [router.asPath])
      }
      return path !== '/login' && !path.startsWith('/invites') && <Button id='login' onClick={signIn}>login</Button>
    }
  }

  const NavItems = ({ className }) => {
    return (
      <>
        <Nav.Item className={className}>
          <Link href={prefix + '/recent'} passHref>
            <Nav.Link className={styles.navLink}>recent</Nav.Link>
          </Link>
        </Nav.Item>
        {!prefix &&
          <Nav.Item className={className}>
            <Link href='/top/posts/week' passHref>
              <Nav.Link className={styles.navLink}>top</Nav.Link>
            </Link>
          </Nav.Item>}
        <Nav.Item className={className}>
          <div className='position-relative'>
            <Link href='/~jobs' passHref>
              <Nav.Link active={sub === 'jobs'} className={styles.navLink}>
                jobs
              </Nav.Link>
            </Link>
            {sub !== 'jobs' && (!me || me.noteJobIndicator) && (!lastCheckedJobs || lastCheckedJobs < subLatestPost?.subLatestPost) &&
              <span className={styles.jobIndicator}>
                <span className='invisible'>{' '}</span>
              </span>}
          </div>
        </Nav.Item>
        {me &&
          <Nav.Item className={className}>
            <Link href={prefix + '/post'} passHref>
              <Nav.Link className={styles.navLinkButton}>post</Nav.Link>
            </Link>
          </Nav.Item>}
      </>
    )
  }

  return (
    <>
      <Container className='px-sm-0'>
        <Navbar className='pb-0 pb-md-1'>
          <Nav
            className={styles.navbarNav}
            activeKey={path}
          >
            <div className='d-flex'>
              <Link href='/' passHref>
                <Navbar.Brand className={`${styles.brand} d-none d-md-block`}>
                  STACKER NEWS
                </Navbar.Brand>
              </Link>
              <Link href='/' passHref>
                <Navbar.Brand className={`${styles.brand} d-block d-md-none`}>
                  SN
                </Navbar.Brand>
              </Link>
            </div>
            <NavItems className='d-none d-md-flex' />
            <Nav.Item className={`text-monospace nav-link px-0 ${me?.name.length > 6 ? 'd-none d-lg-flex' : ''}`}>
              <Price />
            </Nav.Item>
            <Corner />
          </Nav>
        </Navbar>
        <Navbar className='pt-0 pb-1 d-md-none'>
          <Nav
            className={`${styles.navbarNav} justify-content-around`}
            activeKey={path}
          >
            <NavItems />
          </Nav>
        </Navbar>
      </Container>
    </>
  )
}
