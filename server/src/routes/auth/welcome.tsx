import { type FormEvent, useState } from 'react'
import { Redirect, useLocation } from 'wouter'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useSession, useUser } from '@/hooks/auth'
import { useCreateWorkspace } from '@/hooks/workspace'
import { AuthLayout } from './auth-layout'
import { TextField } from './fields'

export default function Welcome() {
  const user = useUser()
  const workspaces = useSession().data?.workspaces ?? []
  const create = useCreateWorkspace()
  const [, navigate] = useLocation()
  const [name, setName] = useState('Home')
  const [creating, setCreating] = useState(false)

  if (workspaces.length && !creating) return <Redirect to="~/" replace />

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    setCreating(true)
    create.mutate(name.trim(), {
      onSuccess: (workspace) => navigate(`~/w/${workspace.id}/devices/add`, { replace: true }),
      onError: () => setCreating(false),
    })
  }

  const firstName = user?.name.split(/\s+/)[0]
  return (
    <AuthLayout
      title={firstName ? `Welcome, ${firstName}` : 'Welcome'}
      description="First, name the place your printers are. You can add more places later, like an office or a family member's home."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
        <TextField
          id="workspace-name"
          label="Name this place"
          description="For example Home, Office, or Grandma's house."
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
          autoFocus
        />
        <Button type="submit" size="lg" className="w-full" disabled={!name.trim() || create.isPending}>
          {create.isPending && <Spinner data-icon="inline-start" />}
          Continue
        </Button>
      </form>
    </AuthLayout>
  )
}
