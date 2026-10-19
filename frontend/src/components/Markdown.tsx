// Markdown das mensagens, sem HTML cru (react-markdown não interpreta HTML por padrão) e sem buscar
// imagens remotas (vazaria o IP): imagens viram links. XSS aqui = vazamento da senha no desbloqueio.
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) =>
          url.startsWith('clearchat-attachment:') ? '' : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ src, alt }) =>
            typeof src === 'string' && src ? (
              <a href={src} target="_blank" rel="noopener noreferrer nofollow">
                [imagem{alt ? `: ${alt}` : ''}]
              </a>
            ) : (
              <span className="text-subtle">[imagem{alt ? `: ${alt}` : ''}]</span>
            )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
