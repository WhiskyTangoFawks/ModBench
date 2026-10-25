using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginRefusalTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public async Task Compile_WithTwoDocumentsClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        TreeTampering.Duplicate(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(_mod.Npc.ToString(), refused.Message);
    }

    [Fact]
    public async Task Compile_WithADocumentItCannotRead_RefusesNamingTheFile()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        using var held = TreeTampering.HoldOpen(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, file), refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithTwoBrokenFiles_RefusesNamingBothAndTheFieldAtFaultInEach()
    {
        var otherIdentity = new RecordIdentity(_mod.OtherNpc.ToString(), CompileFixture.NpcRecordType, CompileFixture.OtherNpcEditorId);
        var npcFile = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        var otherFile = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, otherIdentity);
        _mod.Overwrite(_mod.NpcIdentity, _mod.Document(_mod.Npc.ToString()).Require().Body.Replace("\"Race\"", "\"RaceOld\"", StringComparison.Ordinal));
        _mod.Overwrite(otherIdentity, _mod.Document(_mod.OtherNpc.ToString()).Require().Body.Replace("\"EditorID\"", "\"EditorTypo\"", StringComparison.Ordinal));

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.SourceDoesNotParse, refused.Refusal);
        Assert.Contains($"{Path.GetRelativePath(_mod.ModFolder, npcFile)}: RaceOld", refused.Message, StringComparison.Ordinal);
        Assert.Contains($"{Path.GetRelativePath(_mod.ModFolder, otherFile)}: EditorTypo", refused.Message, StringComparison.Ordinal);
        Assert.Empty(answer.Applied);
    }
}
