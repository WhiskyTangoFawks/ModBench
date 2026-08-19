using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Session;
using MEditService.Tests.Api;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.Records;

/// <summary>
/// #410/ADR-0041: pending changes have no storage. The session database used to gain
/// <c>pending_changes</c> and <c>pending_form_references</c> the moment a session loaded — the
/// pending model's store, sitting in the same connection as the index it overlaid.
///
/// Asserted against a real backend host (<see cref="LoadedApiFixture{TPlugin}"/>), not a
/// hand-built SessionManager: the tables were only ever created by the production DI graph wiring
/// a pending-change service into the session lifecycle, so a hand-built manager would report them
/// absent whether or not the machinery still existed.
///
/// The absence assertion carries a positive control drawn from the same table listing: surviving
/// index tables must be found by the identical query. Without it, an empty result, a wrong
/// connection or a typo'd catalog name would satisfy "the pending tables are absent" just as well
/// as a real deletion does.
/// </summary>
public sealed class SessionDatabaseTablesTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private static IReadOnlyList<string> TableNamesOf(DuckDBConnection connection)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT table_name FROM information_schema.tables";
        var names = new List<string>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) names.Add(reader.GetString(0));
        return names;
    }

    [Fact]
    public void ALoadedSession_HasNoPendingChangeTables()
    {
        var session = loaded.Services.GetRequiredService<ISessionManager>();
        var tables = TableNamesOf(((DuckDbRecordRepository)session.Repository!).Connection);

        // Positive control, same listing: the index tables this ticket preserves are really here,
        // which is what makes the assertions below mean "deleted" rather than "not looking".
        Assert.Contains("form_lookup", tables);
        Assert.Contains("form_references", tables);
        Assert.Contains("npc_", tables);

        Assert.DoesNotContain("pending_changes", tables);
        Assert.DoesNotContain("pending_form_references", tables);
    }
}
