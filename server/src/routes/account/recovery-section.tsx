import { Download } from 'lucide-react'
import { useState } from 'react'
import { Confirm } from '@/components/confirm'
import { CopyButton } from '@/components/copy'
import { Section } from '@/components/page'
import { Button } from '@/components/ui/button'
import { useUser } from '@/hooks/auth'
import { useRecoveryCodes } from '@/hooks/account'

function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

export function RecoverySection() {
  const user = useUser()
  const create = useRecoveryCodes()
  const [codes, setCodes] = useState<string[] | null>(null)
  const text = codes?.join('\n') ?? ''

  return (
    <Section
      id="recovery"
      title="Recovery codes"
      description="One-time codes that get you back in if you lose your password or passkey. Keep them somewhere safe, like a drawer or a password manager."
    >
      {codes ? (
        <div className="flex flex-col gap-5">
          <p className="rounded-2xl bg-warn-container px-4 py-3 text-[0.9375rem] text-on-warn-container" role="status">
            Save these now. You won’t be able to see them again. Each code works once.
          </p>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Recovery codes">
            {codes.map((code) => (
              <li key={code} className="rounded-xl border bg-surface px-4 py-2.5 text-center font-mono text-base tracking-wider select-all">
                {code}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={text} label="Copy all" size="default" />
            <Button
              variant="outline"
              onClick={() => downloadText(`print-better-recovery-codes-${user?.username ?? 'account'}.txt`, `${text}\n`)}
            >
              <Download data-icon="inline-start" />
              Download as a file
            </Button>
            <Button variant="ghost" onClick={() => setCodes(null)}>
              I saved them
            </Button>
          </div>
        </div>
      ) : (
        <Confirm
          trigger={<Button variant="outline">Create recovery codes</Button>}
          title="Create new recovery codes?"
          description="Any codes you made before will stop working."
          confirmLabel="Create new codes"
          onConfirm={async () => setCodes((await create.mutateAsync()).codes)}
        />
      )}
    </Section>
  )
}
