import type { ReactNode } from 'react'
import { Link } from 'wouter'
import { CopyField } from '@/components/copy'
import { Mono, PageHeader, Section } from '@/components/page'

function Steps({ children }: { children: ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {children.map((step, i) => (
        <li key={i} className="flex gap-3 text-[0.9375rem]">
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-container text-sm font-semibold text-on-brand-container"
          >
            {i + 1}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">{step}</div>
        </li>
      ))}
    </ol>
  )
}

const EXAMPLES = [
  'Set up the printer in my office.',
  'Print this PDF on the kitchen printer, both sides.',
  'Why isn’t my printer working?',
  'Invite my daughter so she can print from her laptop.',
]

export default function ConnectAi() {
  const mcpUrl = `${location.origin}/mcp`
  return (
    <>
      <PageHeader
        title="Connect an AI assistant"
        description="Let an assistant like Claude or ChatGPT set up and use your printers for you. You approve it once, and you can disconnect it any time."
      />
      <div className="flex flex-col gap-10">
        <Section title="Your connection address" description="Every assistant asks for this.">
          <CopyField value={mcpUrl} />
        </Section>

        <Section title="Claude" description="On claude.ai or the Claude desktop app.">
          <Steps>
            {[
              'Open Settings, then Connectors.',
              'Choose Add custom connector.',
              'Name it Print Better and paste the connection address.',
              'Choose Connect. A Print Better page opens; check the details and choose Allow.',
            ]}
          </Steps>
        </Section>

        <Section title="Claude Code" description="In a terminal where Claude Code is installed.">
          <Steps>
            {[
              <div key="run" className="flex flex-col gap-3">
                Run this command:
                <CopyField value={`claude mcp add --transport http print-better ${mcpUrl}`} multiline />
              </div>,
              <>
                Start Claude Code, type <Mono>/mcp</Mono>, pick print-better, and sign in when your browser opens.
              </>,
            ]}
          </Steps>
        </Section>

        <Section title="ChatGPT" description="Needs a plan that allows custom connectors.">
          <Steps>
            {[
              'Open Settings, then Apps and connectors, then Advanced, and turn on Developer mode.',
              'Back in Apps and connectors, choose Create.',
              'Name it Print Better, paste the connection address, and pick OAuth for authentication.',
              'Choose Create, then sign in and choose Allow on the Print Better page.',
            ]}
          </Steps>
        </Section>

        <Section title="Other tools and scripts" description="For tools that don’t support signing in. The same token works for the AI connection address and the REST API.">
          <div className="flex flex-col gap-3 text-[0.9375rem]">
            <p>
              Create a personal API token in{' '}
              <Link href="~/account/tokens" className="font-medium underline underline-offset-4">
                Your account, Apps and tokens
              </Link>
              , then have the tool send it with every request:
            </p>
            <CopyField value="Authorization: Bearer pbt_…" />
          </div>
        </Section>

        <Section title="Things you can ask">
          <ul className="flex flex-col gap-2">
            {EXAMPLES.map((example) => (
              <li key={example} className="rounded-2xl bg-muted px-4 py-3 text-[0.9375rem]">
                “{example}”
              </li>
            ))}
          </ul>
        </Section>

        <p className="px-1 text-sm text-muted-foreground">
          Assistants can do everything you can in Print Better, with the same permissions. See or disconnect them in{' '}
          <Link href="~/account/tokens" className="font-medium text-foreground underline underline-offset-4">
            Apps and tokens
          </Link>
          .
        </p>
      </div>
    </>
  )
}
