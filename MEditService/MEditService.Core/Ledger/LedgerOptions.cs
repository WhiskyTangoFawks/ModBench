namespace MEditService.Core.Ledger;

/// <summary>
/// Where per-mod ledger gitdirs live — "internal Modbench state" (ADR-0040), never inside the mod
/// folder itself (that folder is the working tree; it must contain no git metadata at all). Follows
/// the same location convention Serilog already uses for logs
/// (<c>%LOCALAPPDATA%/mEdit/logs</c> — see <c>Program.cs</c>) rather than inventing a new one:
/// <c>%LOCALAPPDATA%/mEdit/ledgers</c>.
///
/// Overridden per test via DI (<c>WebApplicationFactory&lt;Program&gt;.WithWebHostBuilder</c>
/// replacing the singleton with an instance pointed at a temp directory), not an environment
/// variable — env vars are process-global and xUnit test classes share one process, so a
/// per-class override would risk one test's ledger root leaking into a concurrently running class.
/// </summary>
public sealed record LedgerOptions(string RootPath)
{
    public static LedgerOptions Default { get; } = new(
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "mEdit", "ledgers"));
}
