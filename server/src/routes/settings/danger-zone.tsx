import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation } from 'wouter'
import type { Workspace } from '@shared/types'
import { Row, Section } from '@/components/page'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useDeleteWorkspace } from '@/hooks/workspace'
import { qk } from '@/lib/query'

export function DangerZone({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const remove = useDeleteWorkspace()
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const matches = typed.trim() === workspace.name.trim()

  const confirm = () =>
    remove.mutate(workspace.id, {
      onSuccess: async () => {
        setOpen(false)
        await qc.invalidateQueries({ queryKey: qk.session })
        navigate('~/', { replace: true })
      },
    })

  return (
    <Section id="danger" title="Delete this workspace" flush>
      <Row
        label="Delete workspace"
        description="Removes every printer, device and print job in it, and signs its devices out. This can’t be undone."
      >
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) setTyped('')
          }}
        >
          <AlertDialogTrigger render={<Button variant="destructive">Delete workspace</Button>} />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {workspace.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Everything in this workspace will be removed for everyone. Its devices stop printing until they are added to
                another workspace.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Field>
              <FieldLabel htmlFor="confirm-ws-name">Type the workspace name to confirm</FieldLabel>
              <Input
                id="confirm-ws-name"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={workspace.name}
                autoComplete="off"
              />
            </Field>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
              <Button variant="destructive" onClick={confirm} disabled={!matches || remove.isPending}>
                {remove.isPending && <Spinner data-icon="inline-start" />}
                Delete forever
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Row>
    </Section>
  )
}
