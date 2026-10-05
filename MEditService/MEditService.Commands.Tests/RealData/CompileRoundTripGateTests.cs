using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.RealData;

public sealed class CompileRoundTripGateTests(CompileRoundTripGateFixture fixture)
    : IClassFixture<CompileRoundTripGateFixture>
{
    [Fact]
    public void Compile_AfterTwoEdits_ReserializesToExactlyTheEditedTree()
    {
        Assert.True(fixture.Compiled.Succeeded, fixture.Compiled.RefusalReason);
        Assert.Equal(
            fixture.EditedDocuments,
            fixture.TrackedTree.Where(kv => !kv.Value.AsSpan().SequenceEqual(fixture.EditedTree[kv.Key])).Select(kv => kv.Key).Order(StringComparer.Ordinal));

        var reserialized = CutDownPluginFixture.DeriveSourceTreeFromBinary(fixture.CompiledPluginPath);

        Assert.Equal(fixture.EditedTree.Keys.Order(StringComparer.Ordinal), reserialized.Keys.Order(StringComparer.Ordinal));
        Assert.All(fixture.EditedTree, kv => Assert.True(kv.Value.AsSpan().SequenceEqual(reserialized[kv.Key]), $"{kv.Key}'s content changed across compile."));
    }

    [Fact]
    public void Compile_AfterRenamingTheMiddleResponse_LandsTheRenameAndKeepsTheTopicsResponseOrder()
    {
        Assert.True(fixture.Compiled.Succeeded, fixture.Compiled.RefusalReason);
        using var compiled = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), fixture.CompiledPluginPath), GameRelease.Fallout4);
        var topic = ((IFallout4ModGetter)compiled).Quests.SelectMany(q => q.DialogTopics).Single(t => t.FormKey == fixture.Topic);

        Assert.Equal(fixture.RenamedResponseEditorId, topic.Responses.Single(r => r.FormKey == fixture.RenamedResponse).EditorID);
        Assert.Equal(fixture.TopicResponses, topic.Responses.Select(r => r.FormKey));
    }

    [Fact]
    public async Task Compile_OfAnUnchangedTree_WritesTheSameBytesAgain()
    {
        var result = await fixture.CompileService().CompileOneAsync(fixture.Plugin);

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.True(File.ReadAllBytes(fixture.CompiledPluginPath).AsSpan().SequenceEqual(File.ReadAllBytes(fixture.PluginPath)),
            "Compile is not byte-stable across repeated runs.");
    }
}
