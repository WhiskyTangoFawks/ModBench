using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginMisplacedFileTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private string LayoutPath => Path.GetRelativePath(
        _mod.ModFolder, TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity));

    private string RenameTheNpcFile()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        var renamed = Path.Combine(Path.GetDirectoryName(file) ?? string.Empty, "ByHand.json");
        File.Move(file, renamed);
        return Path.GetRelativePath(_mod.ModFolder, renamed);
    }

    private static bool Misplaces(CompileDiagnostic diagnostic) =>
        diagnostic.Message.Contains("belongs at", StringComparison.Ordinal);

    [Fact]
    public async Task Compile_WithARecordFileRenamedByHand_Succeeds_WithOneDiagnosticOnThatFileNamingWhereItBelongs()
    {
        var belongsAt = LayoutPath;
        var renamed = RenameTheNpcFile();

        var answer = await _mod.CompileService().CompileAsync([_mod.Plugin]);

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        var diagnostic = Assert.Single(diagnostics, Misplaces);
        Assert.Equal(_mod.Npc.ToString(), diagnostic.FormKey);
        Assert.Equal(renamed, diagnostic.SourceRelativePath);
        Assert.Contains(belongsAt, diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_AfterEditingTheRenamedRecord_FindsItAtTheLayoutsName_WithNoMisplacement()
    {
        var belongsAt = LayoutPath;
        var renamed = RenameTheNpcFile();

        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);

        Assert.True(File.Exists(Path.Combine(_mod.ModFolder, belongsAt)));
        Assert.False(File.Exists(Path.Combine(_mod.ModFolder, renamed)));
        var answer = await _mod.CompileService().CompileAsync([_mod.Plugin]);
        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        Assert.DoesNotContain(diagnostics, Misplaces);
    }
}
