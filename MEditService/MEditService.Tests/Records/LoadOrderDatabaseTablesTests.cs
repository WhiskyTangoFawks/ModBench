using DuckDB.NET.Data;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Tests.Api;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.Records;

/// <summary>
/// ADR-0041: what a loaded load order's database actually holds. The reflected per-type wide
/// tables, the VMAD tables and the condition tables are all gone — each type's name belongs to
/// a <c>json_extract</c> view over <c>records</c>, which is what keeps user filter SQL working
/// unchanged.
///
/// Asserted against a real backend host (<see cref="LoadedApiFixture{TPlugin}"/>) rather than a
/// hand-built LoadOrderMirror, so the shape under test is the one the production DI graph builds.
///
/// Every absence assertion carries a positive control drawn from the same catalog listing: a
/// surviving relation must be found by the identical query. Without it, an empty result, a wrong
/// connection or a typo'd catalog name would satisfy "X is absent" just as well as a real deletion.
/// </summary>
public sealed class LoadOrderDatabaseTablesTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private static IReadOnlyList<string> TableNamesOf(DuckDBConnection connection) =>
        NamesOf(connection, "SELECT table_name FROM information_schema.tables");

    // information_schema.tables lists views alongside base tables, so "npc_ is present" says
    // nothing about whether it is still a real table. These two ask the question that matters.
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
        ((DuckDbRecordIndex)loaded.Services.GetRequiredService<ILoadOrderMirror>().Reads!).Connection;

    /// <summary>
    /// The reflected per-type wide tables are gone, and each type's name belongs to
    /// a generated view over <c>records</c> — which is what keeps user filter SQL working.
    ///
    /// Stated as a pair, because "npc_ is not a base table" alone would be satisfied by npc_ not
    /// existing at all: the same name must be absent from the base tables AND present in the views,
    /// both read through the identical catalog query. The surviving index tables are the second
    /// control — they prove the base-table listing is populated and being read correctly, so the
    /// absence is a real deletion rather than an empty result.
    /// </summary>
    [Fact]
    public void AHeldLoadOrder_HasNoPerTypeWideTables_OnlyViewsOverRecords()
    {
        var connection = Connection();
        var baseTables = BaseTableNamesOf(connection);
        var views = ViewNamesOf(connection);

        // Control 1: the base-table listing is real and populated.
        Assert.Contains("records", baseTables);
        Assert.Contains("form_lookup", baseTables);
        Assert.Contains("placement", baseTables);
        // #631 retired the last per-type wide table, the plugin header's — so "header" belongs in
        // the loop below with every other type rather than being called out as the exception it used
        // to be. Listed first in the loop for emphasis: this is the assertion the ticket exists for.
        foreach (var type in (string[])["header", "npc_", "weap", "armo", "cell", "glob"])
        {
            Assert.DoesNotContain(type, baseTables);   // the wide table is gone
            Assert.Contains(type, views);              // ... and the name is a view now
        }
    }

    /// <summary>
    /// VMAD's three side tables are gone — <c>GetVmad</c> reconstitutes from the record's own
    /// document instead. <c>form_references</c> is the positive control, same reasoning as the two
    /// tests above: it is still fed (VMAD-borne refs are collected at ingest off the live
    /// object), so its presence proves the listing is real rather than empty.
    /// </summary>
    [Fact]
    public void AHeldLoadOrder_HasNoVmadTables()
    {
        var tables = TableNamesOf(Connection());

        Assert.Contains("form_references", tables);

        Assert.DoesNotContain("vmad_scripts", tables);
        Assert.DoesNotContain("vmad_properties", tables);
        Assert.DoesNotContain("vmad_property_list_items", tables);
    }

    /// <summary>
    /// Conditions' two side tables are gone — <c>GetConditions</c> reconstitutes from the
    /// record's own document via <c>IConditionCodec.Extract</c> instead. Same positive control as
    /// <see cref="AHeldLoadOrder_HasNoVmadTables"/>, for the same reason.
    /// </summary>
    [Fact]
    public void AHeldLoadOrder_HasNoConditionTables()
    {
        var tables = TableNamesOf(Connection());

        Assert.Contains("form_references", tables);

        Assert.DoesNotContain("conditions", tables);
        Assert.DoesNotContain("condition_parameters", tables);
    }
}
