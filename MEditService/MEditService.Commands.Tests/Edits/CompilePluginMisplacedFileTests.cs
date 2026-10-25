using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;

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

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
        var diagnostic = Assert.Single(diagnostics, Misplaces);
        Assert.Equal(_mod.Npc.ToString(), diagnostic.FormKey);
        Assert.Equal(renamed, diagnostic.SourceRelativePath);
        Assert.Contains(belongsAt, diagnostic.Message, StringComparison.Ordinal);
    }
}
