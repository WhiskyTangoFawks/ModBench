using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class WriteGatesOverAFakeSourceTests
{
    private const string ModFolder = "/fake/mods/FixtureMod";
    private static readonly PluginAddress Plugin = new("Fixture.esp", "FixtureMod");
    private static readonly string Npc = $"000800:{Plugin.Name}";

    private static SourceDocument NpcDocument() =>
        new(Npc, "npc_", "FixtureNpc",
            RecordMint.BareDocument(SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["npc_"], GameRelease.Fallout4, Npc, "FixtureNpc"));

    private static IServiceProvider Over(FakeSourceAdapter source)
    {
        var entry = new LoadOrderEntry(Plugin.Name, Path.Combine(ModFolder, Plugin.Name), Plugin.Origin, 0, Enabled: true, Winning: true);
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot("/fake/game", null, GameRelease.Fallout4, [entry]));
        return TestEditService.Over(holder, source: source);
    }

    private static RecordEditChanges SetHeight(IServiceProvider services, string formKey) =>
        services.GetRequiredService<EditRecordChangesHandler>()
            .Changes(Plugin, formKey, SetAt(JsonDocument.Parse("0.75").RootElement, Member("HeightMax")));

    [Fact]
    public void EditingAPluginOfAnUntrackedMod_IsRefused_NamingTheTrackCommand()
    {
        var result = SetHeight(Over(new FakeSourceAdapter()), Npc).Outcome;

        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Track its mod", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAFormKeyNoDocumentHolds_OnAnUntrackedPlugin_StillRefusesAsUntracked()
    {
        var result = SetHeight(Over(new FakeSourceAdapter()), $"ABCDEF:{Plugin.Name}").Outcome;

        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
    }

    [Fact]
    public void EditingAPlugin_WhoseSourceIsUnreadable_IsRefusedBeforeAnySessionOpens_NamingDecompile()
    {
        var source = new FakeSourceAdapter().TrackingUnreadable(ModFolder);

        var result = SetHeight(Over(source), Npc).Outcome;

        Assert.Equal(RecordEditRefusal.PluginSourceUnreadable, result.Refusal);
        Assert.Contains("Decompile the plugin", result.Message, StringComparison.Ordinal);
        Assert.Equal(0, source.SessionsOpened);
    }

    [Fact]
    public void CreatingARecordInAPlugin_WhoseSourceIsUnreadable_IsRefusedTheSameWay()
    {
        var source = new FakeSourceAdapter().TrackingUnreadable(ModFolder);

        var result = Over(source).GetRequiredService<CreateRecordChangesHandler>().CreateRecord(Plugin, "npc_").Outcome;

        Assert.Equal(RecordEditRefusal.PluginSourceUnreadable, result.Refusal);
        Assert.Equal(0, source.SessionsOpened);
    }

    [Fact]
    public void EditingAFormKeyNoDocumentOfATrackedPlugin_IsRefusedAsRecordNotFound()
    {
        var source = new FakeSourceAdapter().Tracking(ModFolder, NpcDocument());

        var result = SetHeight(Over(source), $"000900:{Plugin.Name}").Outcome;

        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }

    [Fact]
    public void EditingAField_AnswersTheDocumentRewritten_UnderTheModFolder()
    {
        var source = new FakeSourceAdapter().Tracking(ModFolder, NpcDocument());

        var answered = SetHeight(Over(source), Npc);

        Assert.True(answered.Outcome.Applied, answered.Outcome.Message);
        var written = Assert.Single(answered.Changes.Documents);
        Assert.StartsWith(ModFolder, written.Path, StringComparison.Ordinal);
        Assert.Contains("0.75", written.Text, StringComparison.Ordinal);
    }
}
