import type { Mail } from './outbound'

export function inviteMail(p: { to: string; app: string; workspace: string; inviter: string; role: string; url: string; expiresAt: number }): Mail {
  return {
    to: [p.to],
    subject: `${p.inviter} invited you to ${p.workspace} on ${p.app}`,
    text: [
      `${p.inviter} invited you to join "${p.workspace}" on ${p.app} as ${p.role === 'admin' ? 'an admin' : 'a member'}.`,
      '',
      `Accept the invite: ${p.url}`,
      '',
      `The link expires on ${new Date(p.expiresAt).toUTCString()}.`,
    ].join('\n'),
  }
}

export function resetMail(p: { to: string; app: string; url: string }): Mail {
  return {
    to: [p.to],
    subject: `Reset your ${p.app} password`,
    text: [
      `Someone asked to reset the password for your ${p.app} account.`,
      '',
      `Choose a new password: ${p.url}`,
      '',
      'The link works once and expires in one hour. If this was not you, ignore this email.',
    ].join('\n'),
  }
}

export function verifyMail(p: { to: string; app: string; url: string }): Mail {
  return {
    to: [p.to],
    subject: `Confirm your email for ${p.app}`,
    text: [
      `Someone added this address to a ${p.app} account.`,
      '',
      `Confirm it is yours: ${p.url}`,
      '',
      'The link works once and expires in 24 hours. If this was not you, ignore this email.',
    ].join('\n'),
  }
}

export function printerAlertMail(p: { to: string[]; app: string; printer: string; workspace: string; problem: string; url: string }): Mail {
  return {
    to: p.to,
    subject: `${p.printer} needs attention`,
    text: [
      `${p.printer} in "${p.workspace}" reports: ${p.problem}.`,
      '',
      `Printer details: ${p.url}`,
      '',
      `You get at most one of these per printer every 12 hours from ${p.app}.`,
    ].join('\n'),
  }
}

export function approvalRequestMail(p: { to: string[]; app: string; workspace: string; sender: string; title: string; printer: string; reasons: string[]; until: string; url: string }): Mail {
  return {
    to: p.to,
    subject: `${p.sender} needs approval to print "${p.title}"`,
    text: [
      `${p.sender} sent "${p.title}" to ${p.printer} in "${p.workspace}". It waits for approval because:`,
      ...p.reasons.map((r) => `- ${r}`),
      '',
      `Approve or deny it: ${p.url}`,
      '',
      `If nobody answers by ${p.until}, it is canceled. You get this email from ${p.app} because you can approve this job.`,
    ].join('\n'),
  }
}

export function usageAlertMail(p: { to: string[]; app: string; workspace: string; name: string; threshold: number; whose: string | null; used: string; amount: string; resets: string; url: string }): Mail {
  const count = p.whose ? `${p.whose} count of ${p.name}` : p.name
  return {
    to: p.to,
    subject: `${p.name}: ${p.threshold}% used`,
    text: [
      `${count} in "${p.workspace}" is at ${p.threshold}%: ${p.used} of ${p.amount} used. It resets on ${p.resets}.`,
      ...(p.threshold >= 100 ? ['', 'Jobs that would go over it are blocked, warned about, or sent for approval, depending on its setting.'] : []),
      '',
      `See usage: ${p.url}`,
      '',
      `You get at most one of these per threshold and cycle from ${p.app}.`,
    ].join('\n'),
  }
}

export function scheduledReportMail(p: { to: string[]; app: string; workspace: string; name: string; period: string; lines: string[]; url: string; csv: { filename: string; content: string } }): Mail {
  return {
    to: p.to,
    subject: `${p.name}: ${p.period}`,
    text: [`Printing in "${p.workspace}", ${p.period}.`, '', ...p.lines, '', `Every row is in the attached CSV. Open Reports: ${p.url}`, '', `Sent by ${p.app}.`].join('\n'),
    attachments: [{ filename: p.csv.filename, contentType: 'text/csv; charset=utf-8', content: p.csv.content }],
  }
}
