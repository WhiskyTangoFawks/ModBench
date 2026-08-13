using MEditService.Core.Session;

namespace MEditService.Tests;

internal static class GameSessionTestExtensions
{
    /// <summary>
    /// Drives <see cref="GameSession.OpenAll"/> to completion and returns the session — the eager
    /// open the constructor performed before #274 made opening a separate, interleavable phase.
    ///
    /// For tests whose subject is a *fully opened* session (metadata, origin, participation,
    /// masters). Tests whose subject is the progressive open itself drive the enumeration
    /// themselves and must not use this.
    /// </summary>
    internal static GameSession Opened(this GameSession session)
    {
        foreach (var _ in session.OpenAll()) { }
        return session;
    }
}
