using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

public sealed class RecordTypeViewsTests
{
    private static DuckDbRecordIndex FreshIndex()
    {
        var index = new DuckDbRecordIndex(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance), NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);
        return index;
    }

    private static HashSet<string> ViewNames(DuckDbRecordIndex index)
    {
        using var cmd = index.Connection.CreateCommand();
        cmd.CommandText = "SELECT view_name FROM duckdb_views() WHERE NOT internal";
        using var reader = cmd.ExecuteReader();
        var names = new HashSet<string>(StringComparer.Ordinal);
        while (reader.Read()) names.Add(reader.GetString(0));
        return names;
    }

    [Fact]
    public void AFreshIndex_HasNoPerTypeViews_UntilTheFirstFilterNeedsThem()
    {
        using var index = FreshIndex();
        Assert.Contains("records", ViewNames(index));
        Assert.DoesNotContain("npc_", ViewNames(index));

        index.SetFilter("SELECT form_key FROM npc_");

        Assert.Contains("npc_", ViewNames(index));
        Assert.Contains("header", ViewNames(index));
    }

    [Fact]
    public void CreateRecordTypeViews_OpensTheSqlDoor_WithoutSettingAFilter()
    {
        using var index = FreshIndex();

        index.CreateRecordTypeViews();

        Assert.Contains("npc_", ViewNames(index));
        Assert.Empty(index.At(RecordRef.Effective).Search(new RecordQuery(Limit: 10)).Items);
    }
}
