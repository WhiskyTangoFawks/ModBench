namespace MEditService.Core.Session;

/// <summary>
/// A session-scoped operation was refused because a load is in flight (#279 / ADR-0035). Distinct
/// from "no session loaded": there *is* a session, it is just still being built, and the caller's
/// request is answerable later without anything having gone wrong — the same distinction
/// <c>SessionEndpoints.SupersededLoad</c> draws, and the reason both answer 409 rather than 500.
/// <para>
/// Deliberately derived from <see cref="Exception"/> rather than
/// <see cref="InvalidOperationException"/>, which every session-gated endpoint already maps to 503:
/// as a subclass it would be caught by whichever <c>catch</c> came first, so a later reordering
/// could silently downgrade a 409 to "no session loaded" with nothing failing.
/// </para>
/// </summary>
public sealed class SessionBusyException : Exception
{
    public SessionBusyException() { }
    public SessionBusyException(string message) : base(message) { }
    public SessionBusyException(string message, Exception innerException) : base(message, innerException) { }
}
