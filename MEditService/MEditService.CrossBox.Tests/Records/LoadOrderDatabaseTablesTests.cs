using DuckDB.NET.Data;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.Api;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.Records;

/// <summary>Every absence assertion carries a positive control from the same catalog listing,
/// or an empty result would satisfy "X is absent" as well as a real deletion.</summary>
[Collection(WebHostCollection.Name)]
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

    private DuckDbRecordIndex Index() =>
        (DuckDbRecordIndex)loaded.Services.GetRequiredService<IndexProjector>().Store!;

    private DuckDBConnection Connection() => Index().Connection;

    [Fact]
    public void AHeldLoadOrder_HasNoPerTypeWideTables_OnlyViewsOverRecords()
    {
        Index().CreateRecordTypeViews();
        var connection = Connection();
        var baseTables = BaseTableNamesOf(connection);
        var views = ViewNamesOf(connection);

        // Control 1: the base-table listing is real and populated.
        Assert.Contains("records", baseTables);
        Assert.Contains("form_lookup", baseTables);
        Assert.Contains("placement", baseTables);
        // No per-type wide table survives for the plugin header, so "header" belongs in the loop below
        // with every other type. Listed first for emphasis.
        foreach (var type in (string[])["header", "npc_", "weap", "armo", "cell", "glob"])
        {
            Assert.DoesNotContain(type, baseTables);   // the wide table is gone
            Assert.Contains(type, views);              // ... and the name is a view now
        }
    }

    [Fact]
    public void AHeldLoadOrder_HasNoVmadTables()
    {
        var tables = TableNamesOf(Connection());

        Assert.Contains("form_references", tables);

        Assert.DoesNotContain("vmad_scripts", tables);
        Assert.DoesNotContain("vmad_properties", tables);
        Assert.DoesNotContain("vmad_property_list_items", tables);
    }

    [Fact]
    public void AHeldLoadOrder_HasNoConditionTables()
    {
        var tables = TableNamesOf(Connection());

        Assert.Contains("form_references", tables);

        Assert.DoesNotContain("conditions", tables);
        Assert.DoesNotContain("condition_parameters", tables);
    }
}
