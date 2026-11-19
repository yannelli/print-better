import { FileText, FileUp, Type, X } from 'lucide-react'
import { type DragEvent, useId, useRef, useState } from 'react'
import { DOC_TYPES } from '@shared/types'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { bytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fileContentType } from './use-print-submit'

export type SourceDraft = { kind: 'file'; file: File | null } | { kind: 'text'; text: string }

export function sourceProblem(source: SourceDraft, maxUploadMb: number): string | null {
  if (source.kind === 'text') return null
  if (!source.file) return null
  if (!fileContentType(source.file)) return 'This kind of file can’t be printed yet. Use a PDF, a photo (JPG or PNG), or a plain text file.'
  if (source.file.size > maxUploadMb * 1024 * 1024) return `This file is ${bytes(source.file.size)}. The limit here is ${maxUploadMb} MB.`
  return null
}

function FileDrop({ file, onFile, disabled }: { file: File | null; onFile: (file: File | null) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped && !disabled) onFile(dropped)
  }
  if (file) {
    return (
      <div className="flex items-center gap-4 rounded-2xl border bg-surface p-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-container text-on-brand-container">
          <FileText className="size-6" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{file.name}</span>
          <span className="text-sm text-muted-foreground">{bytes(file.size)}</span>
        </span>
        <Button type="button" variant="ghost" size="icon" aria-label="Remove this file" onClick={() => onFile(null)} disabled={disabled}>
          <X />
        </Button>
      </div>
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        disabled={disabled}
        className={cn(
          'press flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center hover:bg-muted',
          over && 'border-brand bg-brand-container text-on-brand-container',
        )}
      >
        <FileUp className="size-8 text-muted-foreground" />
        <span className="text-base font-medium">Drop a file here, or choose one</span>
        <span className="text-sm text-muted-foreground">PDF, JPG, PNG or plain text</span>
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept={[...DOC_TYPES, '.pdf', '.jpg', '.jpeg', '.png', '.txt'].join(',')}
        onChange={(e) => {
          onFile(e.target.files?.[0] ?? null)
          e.target.value = ''
        }}
      />
    </>
  )
}

export function SourcePicker({
  value,
  onChange,
  problem,
  disabled,
}: {
  value: SourceDraft
  onChange: (next: SourceDraft) => void
  problem: string | null
  disabled?: boolean
}) {
  const id = useId()
  const [text, setText] = useState(value.kind === 'text' ? value.text : '')
  const [file, setFile] = useState(value.kind === 'file' ? value.file : null)
  return (
    <Tabs
      value={value.kind}
      onValueChange={(kind) => onChange(kind === 'text' ? { kind: 'text', text } : { kind: 'file', file })}
      className="gap-4"
    >
      <TabsList aria-label="What to print">
        <TabsTrigger value="file" disabled={disabled}>
          <FileUp />
          A file
        </TabsTrigger>
        <TabsTrigger value="text" disabled={disabled}>
          <Type />
          Some text
        </TabsTrigger>
      </TabsList>
      <TabsContent value="file">
        <FileDrop
          file={file}
          disabled={disabled}
          onFile={(f) => {
            setFile(f)
            onChange({ kind: 'file', file: f })
          }}
        />
      </TabsContent>
      <TabsContent value="text">
        <label htmlFor={`${id}-text`} className="sr-only">
          Text to print
        </label>
        <Textarea
          id={`${id}-text`}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value)
            onChange({ kind: 'text', text: e.target.value })
          }}
          placeholder="Type or paste what you want to print"
          className="min-h-40 max-h-72"
        />
      </TabsContent>
      {problem && <FieldError>{problem}</FieldError>}
    </Tabs>
  )
}
