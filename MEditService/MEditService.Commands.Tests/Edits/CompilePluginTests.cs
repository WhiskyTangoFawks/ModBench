using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginTests : IDisposable
{
    private const uint MovedNpcId = 0x000900;
    private const uint CreatedNpcId = 0x000910;

    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private CompilePluginHandler CompileService() =>
        _mod.CompileService();

    private async Task<(IFallout4ModGetter Mod, IDisposable Handle)> CompileAndReimport()
    {
        var answer = await CompileService().CompileAsync([_mod.Plugin]);
        Assert.Empty(answer.Refused);
        Assert.Single(answer.Landed);

        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
        return ((IFallout4ModGetter)overlay, overlay);
    }

    [Fact]
    public async Task Compile_AfterAnEdit_WritesABinaryThatReparsesWithTheChangeLanded()
    {
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        Assert.Empty(answer.Refused);
        Assert.Single(answer.Landed);

        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        var npc = overlay.Npcs.Single(n => n.FormKey == _mod.Npc);
        Assert.Equal(0.75f, npc.HeightMax);
    }

    [Fact]
    public async Task Compile_LeavesUntouchedRecordsUnchanged()
    {
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        await CompileService().CompileAsync([_mod.Plugin]);

        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        Assert.Contains(overlay.Npcs, n => n.FormKey == _mod.OtherNpc);
        Assert.Contains(overlay.Races, r => r.FormKey == _mod.Race);
        Assert.Contains(overlay.Keywords, k => k.FormKey == _mod.Keyword);
    }

    [Fact]
    public async Task Compile_WithASemanticallyBrokenRecord_SucceedsWithDiagnostics()
    {
        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        Assert.Contains(diagnostics, d => d.FormKey == _mod.Race.ToString());
    }

    [Fact]
    public async Task Compile_NamesADiagnosticsOwnDocument_RelativeToTheModFolder()
    {
        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        var diagnostic = diagnostics.First(d => d.FormKey == _mod.Race.ToString());
        var race = _mod.Document(_mod.Race.ToString()).Require();
        Assert.Equal(
            TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, new RecordIdentity(race.FormKey, race.RecordType, race.EditorId)),
            Path.Combine(_mod.ModFolder, diagnostic.SourceRelativePath));
    }

    [Fact]
    public async Task Compile_AfterDeletingTheFirstOfTwoSameTypeRecords_Succeeds_AndTheBinaryReflectsTheDelete()
    {
        _mod.Remove(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId);

        Assert.NotNull(_mod.Document(_mod.OtherNpc.ToString()));

        var (mod, handle) = await CompileAndReimport();
        using (handle)
        {
            var survivor = Assert.Single(mod.Npcs);
            Assert.Equal(_mod.OtherNpc, survivor.FormKey);
            Assert.Equal(CompileFixture.OtherNpcEditorId, survivor.EditorID);
        }
    }

    [Fact]
    public async Task Compile_AfterChangingTheFormIdOfTheFirstOfTwo_Succeeds_WithBothRecordsPresent()
    {
        var moved = _mod.ChangeFormId(_mod.Npc, MovedNpcId);
        Assert.Equal(moved.ToString(), _mod.Document(moved.ToString()).Require().FormKey);
        Assert.NotNull(_mod.Document(_mod.OtherNpc.ToString()));

        var (mod, handle) = await CompileAndReimport();
        using (handle)
        {
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == _mod.Npc);
            Assert.Contains(mod.Npcs, n => n.FormKey == moved);
            Assert.Contains(mod.Npcs, n => n.FormKey == _mod.OtherNpc);
        }
    }

    [Fact]
    public async Task Compile_AfterStackedDeletesCreatesAndAFormIdEdit_Succeeds_WithExactlyTheSurvivors()
    {
        var created1 = _mod.CreateNpc("Created1", CreatedNpcId);
        _mod.CreateNpc("Created2", CreatedNpcId + 1);
        _mod.Remove(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId);
        var moved = _mod.ChangeFormId(_mod.OtherNpc, MovedNpcId);
        _mod.Remove(created1, CompileFixture.NpcRecordType, "Created1");

        var (mod, handle) = await CompileAndReimport();
        using (handle)
        {
            Assert.Equal(2, mod.Npcs.Count);
            Assert.Contains(mod.Npcs, n => n.FormKey == moved);
            Assert.Contains(mod.Npcs, n => n.EditorID == "Created2");
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == _mod.Npc);
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == created1);
        }
    }

    [Fact]
    public async Task Compile_OfATreeHoldingADocumentTheCodecDoesNotProduce_RefusesNamingItAndDecompile()
    {
        var stray = TreeTampering.StrayGroupDocument(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, stray), refused.Message, StringComparison.Ordinal);
        Assert.Contains("Decompile the plugin to regenerate the source.", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Track", refused.Message, StringComparison.Ordinal);
    }
}
