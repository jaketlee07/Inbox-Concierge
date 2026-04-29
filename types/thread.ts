// In-memory metadata view of a Gmail thread. Used in the request lifecycle
// only — never persisted to Postgres (privacy contract: subject, snippet, and
// full sender stay out of the DB; see CLAUDE.md "Privacy Architecture").
export interface GmailThread {
  id: string;
  subject: string;
  latestSnippet: string;
  latestSender: string;
  latestSenderDomain: string | undefined;
  latestDate: string;
  isUnread: boolean;
  hasAttachments: boolean;
  messageCount: number;
  labelIds: string[];
}
