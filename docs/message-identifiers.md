# Protocol message identifiers, by byte and by phase

Every message in the PostgreSQL frontend/backend protocol, extracted from the
`protocol-message-formats.html` page of the documentation for every release from 7.4 to 18.

That range is the whole life of the protocol. Major version 3 arrived in 7.4, and everything
here is version 3.0 or 3.2. 3.2, added in 18, changed the layout of `BackendKeyData` and
`CancelRequest` and added no messages, so it makes no difference to this list.

The version column says which releases document the message. "all" means every release from
7.4 to 18. The tables are generated from the pages rather than typed out, so the codes and
identifiers are the specification's and not a recollection of them.

55 messages, 40 of them in every release.

## The type byte is not unique

A type byte identifies a message only once you also know the direction, and sometimes not
even then. Every reused identifier, and what actually tells the cases apart:

| Byte | Frontend | Backend | What disambiguates |
| --- | --- | --- | --- |
| `C` | Close | CommandComplete | Direction alone |
| `c` | CopyDone | CopyDone | Same message either way |
| `D` | Describe | DataRow | Direction alone |
| `d` | CopyData | CopyData | Same message either way |
| `E` | Execute | ErrorResponse | Direction alone |
| `H` | Flush | CopyOutResponse | Direction alone |
| `p` | GSSResponse, PasswordMessage, SASLInitialResponse, SASLResponse | none | **Nothing in the message.** Only the last `R` the server sent |
| `R` | none | AuthenticationCleartextPassword, AuthenticationCryptPassword, AuthenticationGSS, AuthenticationGSSContinue, AuthenticationKerberosV4, AuthenticationKerberosV5, AuthenticationMD5Password, AuthenticationOk, AuthenticationSASL, AuthenticationSASLContinue, AuthenticationSASLFinal, AuthenticationSCMCredential, AuthenticationSSPI | An Int32 code after the length |
| `S` | Sync | ParameterStatus | Direction alone |

`C`, `D`, `E`, `H` and `S` are reused across directions, which costs nothing: a decoder
always knows which way a byte was travelling.

`R` is reused 13 times in one direction and resolves cleanly, because the code
follows the length inside the same message. Codes 1, 4 and 6 are absent from a modern server
because the mechanisms behind them were retired, not because they were reserved.

`p` is the one that hurts. Four frontend messages share it and the message carries no
discriminator at all, so a `p` can only be read by remembering which `R` the server sent
last. A decoder cannot be stateless and cannot read a `p` in isolation. That single byte is
why this codebase threads an auth type through `Decode`.

## The untagged messages

Four frontend messages have no type byte. They begin with an Int32 length and an Int32 code,
and are only sent before the connection is established, which is what makes the ambiguity
tolerable: a reader knows to expect them because nothing has happened yet.

| Message | Code | Versions |
| --- | --- | --- |
| StartupMessage | `196608` | all |
| SSLRequest | `80877103` | all |
| GSSENCRequest | `80877104` | 12 to 18 |
| CancelRequest | `80877102` | all |

`StartupMessage`'s code is the protocol version rather than a request code, which is how it
is told apart from the other three. 196608 is 3.0, and 3.2 sends 196610.

## By phase

### Connection negotiation

Before anything is framed as a tagged message. All four are untagged: an Int32 length then an Int32 code.

| Byte | Message | Dir | Code | Versions |
| --- | --- | --- | --- | --- |
| none | StartupMessage | F | `196608` | all |
| none | SSLRequest | F | `80877103` | all |
| none | GSSENCRequest | F | `80877104` | 12 to 18 |
| none | CancelRequest | F | `80877102` | all |
| `v` | NegotiateProtocolVersion | B |  | 9.3 to 18 |

### Authentication

Every server request is tag `R`, told apart by an Int32 code. Every client reply is tag `p`, told apart by nothing at all.

| Byte | Message | Dir | Code | Versions |
| --- | --- | --- | --- | --- |
| `R` | AuthenticationOk | B | `0` | all |
| `R` | AuthenticationKerberosV4 | B | `1` | 7.4 to 8.0 |
| `R` | AuthenticationKerberosV5 | B | `2` | all |
| `R` | AuthenticationCleartextPassword | B | `3` | all |
| `R` | AuthenticationCryptPassword | B | `4` | 7.4 to 8.3 |
| `R` | AuthenticationMD5Password | B | `5` | all |
| `R` | AuthenticationSCMCredential | B | `6` | 7.4 to 15 |
| `R` | AuthenticationGSS | B | `7` | 8.3 to 18 |
| `R` | AuthenticationGSSContinue | B | `8` | 8.3 to 18 |
| `R` | AuthenticationSSPI | B | `9` | 8.3 to 18 |
| `R` | AuthenticationSASL | B | `10` | 10 to 18 |
| `R` | AuthenticationSASLContinue | B | `11` | 10 to 18 |
| `R` | AuthenticationSASLFinal | B | `12` | 10 to 18 |
| `p` | PasswordMessage | F |  | all |
| `p` | GSSResponse | F |  | 10 to 18 |
| `p` | SASLInitialResponse | F |  | 10 to 18 |
| `p` | SASLResponse | F |  | 10 to 18 |

### Session setup

Sent once authentication succeeds, before the first ReadyForQuery. `ParameterStatus` also belongs in "any time" below: the server sends another whenever a reported setting changes, so a client never has to ask.

| Byte | Message | Dir | Code | Versions |
| --- | --- | --- | --- | --- |
| `S` | ParameterStatus | B |  | all |
| `K` | BackendKeyData | B |  | all |

### Simple query

One Query message, then results until ReadyForQuery. `ReadyForQuery` is listed here but ends an extended-query batch too, in response to `Sync`.

| Byte | Message | Dir | Code | Versions |
| --- | --- | --- | --- | --- |
| `Q` | Query | F |  | all |
| `T` | RowDescription | B |  | all |
| `D` | DataRow | B |  | all |
| `C` | CommandComplete | B |  | all |
| `I` | EmptyQueryResponse | B |  | all |
| `Z` | ReadyForQuery | B |  | all |

### Extended query

A batch the client ends with Sync. An error discards everything up to that Sync.

| Byte | Message | Dir | Code | Versions |
| --- | --- | --- | --- | --- |
| `P` | Parse | F |  | all |
| `1` | ParseComplete | B |  | all |
| `B` | Bind | F |  | all |
| `2` | BindComplete | B |  | all |
| `D` | Describe | F |  | all |
| `t` | ParameterDescription | B |  | all |
| `n` | NoData | B |  | all |
| `E` | Execute | F |  | all |
| `s` | PortalSuspended | B |  | all |
| `C` | Close | F |  | all |
| `3` | CloseComplete | B |  | all |
| `S` | Sync | F |  | all |
| `H` | Flush | F |  | all |

### COPY

Copy-in and copy-out are each a sub-protocol the connection switches into. Copy-both is replication only.

| Byte | Message | Dir | Code | Versions |
| --- | --- | --- | --- | --- |
| `G` | CopyInResponse | B |  | all |
| `H` | CopyOutResponse | B |  | all |
| `W` | CopyBothResponse | B |  | 9.1 to 18 |
| `d` | CopyData | F & B |  | all |
| `c` | CopyDone | F & B |  | all |
| `f` | CopyFail | F |  | all |

### Function call

A legacy path that predates the extended query protocol.

| Byte | Message | Dir | Code | Versions |
| --- | --- | --- | --- | --- |
| `F` | FunctionCall | F |  | all |
| `V` | FunctionCallResponse | B |  | all |

### Any time

Not tied to a phase. These can arrive between other messages, which is what makes them awkward.

| Byte | Message | Dir | Code | Versions |
| --- | --- | --- | --- | --- |
| `E` | ErrorResponse | B |  | all |
| `N` | NoticeResponse | B |  | all |
| `A` | NotificationResponse | B |  | all |

### Termination

| Byte | Message | Dir | Code | Versions |
| --- | --- | --- | --- | --- |
| `X` | Terminate | F |  | all |

## What changed between 7.4 and 18

Fifteen messages arrived or departed inside the range. Everything else has been there
throughout, and nothing has changed since 12.

- **AuthenticationCryptPassword** (`R`, code `4`) is documented up to 8.3 and gone after it.
- **AuthenticationGSS** appears from 8.3 onward.
- **AuthenticationGSSContinue** appears from 8.3 onward.
- **AuthenticationKerberosV4** (`R`, code `1`) is documented up to 8.0 and gone after it.
- **AuthenticationSASL** appears from 10 onward.
- **AuthenticationSASLContinue** appears from 10 onward.
- **AuthenticationSASLFinal** appears from 10 onward.
- **AuthenticationSCMCredential** (`R`, code `6`) is documented up to 15 and gone after it.
- **AuthenticationSSPI** appears from 8.3 onward.
- **CopyBothResponse** appears from 9.1 onward.
- **GSSENCRequest** appears from 12 onward.
- **GSSResponse** appears from 10 onward.
- **NegotiateProtocolVersion** appears from 9.3 onward.
- **SASLInitialResponse** appears from 10 onward.
- **SASLResponse** appears from 10 onward.

None of those is a change to the wire format of an existing message, which is why none of
them needed a protocol version bump. The one change that did need one, in 3.2, is invisible
here: it altered the layout of `BackendKeyData` and `CancelRequest` rather than adding or
removing a message, so the identifiers and the codes stayed the same.
