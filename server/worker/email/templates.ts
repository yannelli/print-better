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
