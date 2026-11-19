import { describe, expect, it } from 'vitest'
import { approvalRequestMail } from '../worker/email/templates'
import { csv } from '../worker/extensions/enterprise/csv'

describe('CSV cells', () => {
  it('get a leading quote when a spreadsheet would run them, but numbers stay as they are', () => {
    const row = ['=1+2', '+1', '-x', '@SUM(A1)', '\tx', '\rx', '-12.50', -3, 'plain']
    expect(csv(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], [row]).split('\r\n')[1]).toBe(`'=1+2,'+1,'-x,'@SUM(A1),'\tx,"'\rx",-12.50,-3,plain`)
  })
})

describe('emails', () => {
  it('keep titles and names on one line', () => {
    const mail = approvalRequestMail({
      to: ['approver@example.com'],
      app: 'Print Better',
      workspace: 'Front\noffice',
      sender: 'Bob\r\nBcc: someone@example.com',
      title: 'Report\n\nOpen this link',
      printer: 'Laser\u2028Two',
      reasons: ['Over\nthe limit'],
      until: 'Monday',
      url: 'https://print.example.com/jobs/approvals',
    })
    expect(mail.subject).toBe('Bob Bcc: someone@example.com needs approval to print "Report Open this link"')
    expect(mail.text.split('\n').slice(0, 2)).toEqual([
      'Bob Bcc: someone@example.com sent "Report Open this link" to Laser Two in "Front office". It waits for approval because:',
      '- Over the limit',
    ])
  })
})
