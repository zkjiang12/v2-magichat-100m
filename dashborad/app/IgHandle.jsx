import Link from 'next/link';

export function igProfileUrl(handle, profileUrl) {
  return profileUrl || `https://www.instagram.com/${String(handle || '').replace(/^@/, '')}/`;
}

// @handle that opens the Instagram profile. When `href` points at an internal
// detail page, the handle keeps that link and a small "IG" link opens the
// profile in a new tab instead. Pass `emails` (creators.emails) to show the
// first one as a mailto link in parentheses.
export default function IgHandle({ handle, href, profileUrl, emails }) {
  if (!handle) return null;
  const instagramUrl = igProfileUrl(handle, profileUrl);

  return (
    <span className="ig-handle-wrap">
      {href ? (
        <>
          <Link href={href}>@{handle}</Link>
          {' '}
          <a
            className="ig-ext-link"
            href={instagramUrl}
            target="_blank"
            rel="noreferrer"
            title={`@${handle} on Instagram`}
          >
            IG
          </a>
        </>
      ) : (
        <a href={instagramUrl} target="_blank" rel="noreferrer" title={`@${handle} on Instagram`}>
          @{handle}
        </a>
      )}
      <EmailNote emails={emails} />
    </span>
  );
}

// "(jane@x.com +1)" with a mailto link; null when the creator has no emails.
export function EmailNote({ emails }) {
  const list = (Array.isArray(emails) ? emails : []).filter(Boolean);
  if (list.length === 0) return null;

  return (
    <span className="ig-email" title={list.join(', ')}>
      {' ('}
      <a href={`mailto:${list[0]}`}>{list[0]}</a>
      {list.length > 1 ? ` +${list.length - 1}` : ''}
      {')'}
    </span>
  );
}
