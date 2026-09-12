using MEditService.Commands.Edits;
using MEditService.SourceRepo;

namespace MEditService.Tests.Edits;

/// <summary>What a compile at a named ref asks of that ref rather than of the files on disk: which
/// FormKeys more than one document claims, and where a diagnostic's record lives.</summary>
public sealed class PluginCompileServiceAtRefSourceTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private PluginCompileService CompileService() => _mod.CompileService();

    // Committed and then deleted from the working tree: the working-tree compile succeeding is what
    // makes the refusal at the ref an answer about the ref.
    [Fact]
    public void Compile_AtARefWhoseSourceHasTwoDocumentsClaimingOneFormKey_RefusesNamingTheFormKey()
    {
        var collidingPath = _mod.SourceFileFor(_mod.Npc, "Keyword", CompileFixture.NpcEditorId);
        Directory.CreateDirectory(Path.GetDirectoryName(collidingPath)!);
        File.WriteAllText(collidingPath, File.ReadAllText(_mod.NpcSourceFile));
        _mod.CommitWorkingTree("two documents, one FormKey");
        File.Delete(collidingPath);

        var workingTree = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());
        var atRef = CompileService().Compile(_mod.Plugin, new CompileSource.AtRef("HEAD"));

        Assert.True(workingTree.Succeeded, workingTree.RefusalReason);
        Assert.False(atRef.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), atRef.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public void Compile_AtARef_NamesADiagnosticsOwnDocument_RelativeToTheModFolder()
    {
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.AtRef("HEAD"));

        Assert.True(result.Succeeded, result.RefusalReason);
        var diagnostic = result.Diagnostics.First(d => d.FormKey == _mod.Race.ToString());
        Assert.StartsWith(
            SourceRepository.RootFor(CompileFixture.PluginName), diagnostic.SourceRelativePath, StringComparison.Ordinal);
        var full = Path.Combine(_mod.ModFolder, diagnostic.SourceRelativePath);
        Assert.True(File.Exists(full), $"'{diagnostic.SourceRelativePath}' is not a file in the tree.");
        Assert.Contains(_mod.Race.ToString(), File.ReadAllText(full), StringComparison.Ordinal);
    }
}
