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
    private static IReadOnlyList<string> TableNamesOf(DuckDBConnection connection) =>
        NamesOf(connection, "SELECT table_name FROM information_schema.tables");

    // #413: information_schema.tables lists views alongside base tables, so "npc_ is present" says
    // nothing about whether it is still a real table. These two ask the question that now matters.
    private static IReadOnlyList<string> BaseTableNamesOf(DuckDBConnection connection) =>
        NamesOf(connection, "SELECT table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE'");

    private static IReadOnlyList<string> ViewNamesOf(DuckDBConnection connection) =>
        NamesOf(connection, "SELECT table_name FROM information_schema.tables WHERE table_type = 'VIEW'");

    private static IReadOnlyList<string> NamesOf(DuckDBConnection connection, string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        var names = new List<string>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) names.Add(reader.GetString(0));
        return names;
    }

    private DuckDBConnection Connection() =>
        ((DuckDbRecordRepository)loaded.Services.GetRequiredService<ISessionManager>().Repository!).Connection;

    [Fact]
    public void ALoadedSession_HasNoPendingChangeTables()
    {
        var tables = TableNamesOf(Connection());

        // Positive control, same listing: the index tables this ticket preserves are really here,
        // which is what makes the assertions below mean "deleted" rather than "not looking".
        Assert.Contains("form_lookup", tables);
        Assert.Contains("form_references", tables);
        Assert.Contains("npc_", tables);

        Assert.DoesNotContain("pending_changes", tables);
        Assert.DoesNotContain("pending_form_references", tables);
    }

    /// <summary>
    /// #413 / AC1: the reflected per-type wide tables are gone, and each type's name now belongs to
    /// a generated view over <c>records</c> — which is what keeps user filter SQL working across the
    /// swap.
    ///
    /// Stated as a pair, because "npc_ is not a base table" alone would be satisfied by npc_ not
    /// existing at all: the same name must be absent from the base tables AND present in the views,
    /// both read through the identical catalog query. The surviving index tables are the second
    /// control — they prove the base-table listing is populated and being read correctly, so the
    /// absence is a real deletion rather than an empty result.
    /// </summary>
    [Fact]
    public void ALoadedSession_HasNoPerTypeWideTables_OnlyViewsOverRecords()
    {
        var connection = Connection();
        var baseTables = BaseTableNamesOf(connection);
        var views = ViewNamesOf(connection);

        // Control 1: the base-table listing is real and populated.
        Assert.Contains("records", baseTables);
        Assert.Contains("form_lookup", baseTables);
        Assert.Contains("placement", baseTables);
        // The header is the one surviving per-type table (D8) — a ModHeader has no document.
        Assert.Contains("header", baseTables);

        foreach (var type in (string[])["npc_", "weap", "armo", "cell", "glob"])
        {
            Assert.DoesNotContain(type, baseTables);   // the wide table is gone
            Assert.Contains(type, views);              // ... and the name is a view now
        }
    }

    /// <summary>
    /// #420: VMAD's three side tables are gone — <c>GetVmad</c> reconstitutes from the record's own
    /// document instead. <c>form_references</c> is the positive control, same reasoning as the two
    /// tests above: it is still fed (VMAD-borne refs move to ingest-time collection off the live
    /// object, #420 AC4), so its presence proves the listing is real rather than empty.
    /// </summary>
    [Fact]
    public void ALoadedSession_HasNoVmadTables()
    {
        var tables = TableNamesOf(Connection());

        Assert.Contains("form_references", tables);

        Assert.DoesNotContain("vmad_scripts", tables);
        Assert.DoesNotContain("vmad_properties", tables);
        Assert.DoesNotContain("vmad_property_list_items", tables);
    }

    /// <summary>
    /// #420: conditions' two side tables are gone — <c>GetConditions</c> reconstitutes from the
    /// record's own document via <c>IConditionCodec.Extract</c> instead. Same positive control as
    /// <see cref="ALoadedSession_HasNoVmadTables"/>, for the same reason.
    /// </summary>
    [Fact]
    public void ALoadedSession_HasNoConditionTables()
    {
        var tables = TableNamesOf(Connection());

        Assert.Contains("form_references", tables);

        Assert.DoesNotContain("conditions", tables);
        Assert.DoesNotContain("condition_parameters", tables);
    }
}
