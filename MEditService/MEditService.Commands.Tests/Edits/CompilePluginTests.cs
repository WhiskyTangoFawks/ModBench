using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginTests : IDisposable
{
    private const uint MovedNpcId = 0x000900;
    private const uint CreatedNpcId = 0x000910;

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
    public async Task Compile_AfterAnEdit_WritesEveryRecordItLeftUntouchedAsItsDocumentNamesIt()
    {
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);

        using var compiled = await _mod.CompiledAsync(_mod.Plugin);

        Assert.Equal(
            ["FixtureRace", "FixtureKeyword", CompileFixture.OtherNpcEditorId],
            new[] { _mod.Race, _mod.Keyword, _mod.OtherNpc }.Select(key => compiled.EnumerateMajorRecords().Single(r => r.FormKey == key).EditorID));
    }

    [Fact]
    public async Task Compile_NamesADiagnosticsOwnDocument_RelativeToTheModFolder()
    {
        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
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

        using var compiled = await _mod.CompiledAsync(_mod.Plugin);

        var survivor = Assert.Single(compiled.Npcs);
        Assert.Equal((_mod.OtherNpc, CompileFixture.OtherNpcEditorId), (survivor.FormKey, survivor.EditorID));
    }

    [Fact]
    public async Task Compile_AfterChangingTheFormIdOfTheFirstOfTwo_Succeeds_WithBothRecordsPresent()
    {
        var moved = _mod.ChangeFormId(_mod.Npc, MovedNpcId);

        using var compiled = await _mod.CompiledAsync(_mod.Plugin);

        Assert.Equal([_mod.OtherNpc.ToString(), moved.ToString()], compiled.Npcs.Select(n => n.FormKey.ToString()).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Compile_AfterStackedDeletesCreatesAndAFormIdEdit_Succeeds_WithExactlyTheSurvivors()
    {
        var created1 = _mod.CreateNpc("Created1", CreatedNpcId);
        var created2 = _mod.CreateNpc("Created2", CreatedNpcId + 1);
        _mod.Remove(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId);
        var moved = _mod.ChangeFormId(_mod.OtherNpc, MovedNpcId);
        _mod.Remove(created1, CompileFixture.NpcRecordType, "Created1");

        using var compiled = await _mod.CompiledAsync(_mod.Plugin);

        Assert.Equal([moved.ToString(), created2.ToString()], compiled.Npcs.Select(n => n.FormKey.ToString()).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Compile_OfATreeHoldingADocumentTheCodecDoesNotProduce_RefusesNamingItAndDecompile()
    {
        var stray = TreeTampering.StrayGroupDocument(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, stray), refused.Message, StringComparison.Ordinal);
        Assert.Contains("Decompile the plugin to regenerate the source.", refused.Message, StringComparison.Ordinal);
    }
}
