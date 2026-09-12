using System.Text.Json;
using MEditService.PluginAdapter;
using MEditService.LoadOrder;
using MEditService.Index;
using MEditService.Codec.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>An edit is checked for shape and nothing else (ADR-0015 invariant 5): a link no plugin
/// answers lands in the tree, and the read side names it at the next projection.</summary>
public sealed class BrokenLinkProjectionTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static IndexProjector Reload(IndexedModFixture mod)
    {
        var index = new IndexProjector(
            new LoadOrderHolder(),
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        index.Reconcile(new LoadOrderHolder(), mod.GameDirectory, [mod.Entry], GameRelease.Fallout4);
        return index;
    }

    private static string? CheckErrorOnKeywords(IndexProjector index, IndexedModFixture mod)
    {
        var record = index.Store!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(record);
        return record.Fields.Single(field => field.Metadata.Name == "Keywords").CheckError;
    }

    [Fact]
    public void AnEditPointingALinkAtAFormKeyNoPluginProvides_Lands_AndTheProjectionNamesTheMember()
    {
        using var mod = IndexedModFixture.Tracked();

        var result = TestEditService.EditHandler(mod.Holder).Set(
            mod.Plugin, mod.Npc.ToString(), "Keywords", Json("[\"ABCDEF:NoSuchPlugin.esp\"]"));

        Assert.True(result.Applied, result.Message);
        using var reloaded = Reload(mod);
        Assert.Equal(
            "[0]: [ABCDEF:NoSuchPlugin.esp] <Error: Could not be resolved>",
            CheckErrorOnKeywords(reloaded, mod));
    }

    [Fact]
    public void AnEditPointingALinkAtTheWrongRecordType_Lands_AndTheProjectionNamesTheMismatch()
    {
        using var mod = IndexedModFixture.Tracked();

        var result = TestEditService.EditHandler(mod.Holder).Set(
            mod.Plugin, mod.Npc.ToString(), "Keywords", Json($"[\"{mod.Race}\"]"));

        Assert.True(result.Applied, result.Message);
        using var reloaded = Reload(mod);
        Assert.Equal("[0]: Found a race reference, expected: kywd", CheckErrorOnKeywords(reloaded, mod));
    }
}
