using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public async Task Compile_AfterAnEdit_WritesABinaryThatReparsesWithTheChangeLanded()
    {
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);

        using var compiled = await _mod.CompiledAsync(_mod.Plugin);

        Assert.Equal(0.75f, compiled.Npcs.Single(n => n.FormKey == _mod.Npc).HeightMax);
    }

    [Fact]
    public async Task Compile_NamesADiagnosticsOwnDocument_RelativeToTheModFolder()
    {
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.Race.FormKey = FormKey.Factory("000FFF:Compile.esp"));

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
        var diagnostic = Assert.Single(diagnostics, d => d.FormKey == _mod.Npc.ToString());
        var npc = _mod.Document(_mod.Npc.ToString()).Require();
        Assert.NotNull(diagnostic.SourceRelativePath);
        Assert.Equal(
            TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, new RecordIdentity(npc.FormKey, npc.RecordType, npc.EditorId)),
            Path.Combine(_mod.ModFolder, diagnostic.SourceRelativePath));
    }

    [Fact]
    public async Task Compile_OfATreeHoldingADocumentTheCodecDoesNotProduce_RefusesNamingIt()
    {
        var stray = TreeTampering.StrayGroupDocument(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, stray), refused.Message, StringComparison.Ordinal);
        Assert.Equal(CompileRefusal.SourceRegenerable, refused.Refusal);
    }
}
