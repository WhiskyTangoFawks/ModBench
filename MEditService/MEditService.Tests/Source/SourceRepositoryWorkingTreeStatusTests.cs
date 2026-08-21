using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// #417 B1: <see cref="SourceRepository.WorkingTreeStatus"/> — "does the working tree have any
/// uncommitted change at all", the primitive every refuse-over-dirt check in #417 (rebase-over-dirt,
/// Keep-as-My-Edit's same-record collision) is built on. Real git repo, real git CLI — same house
/// pattern as every other <see cref="SourceRepository"/> test.
/// </summary>
public sealed class SourceRepositoryWorkingTreeStatusTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-wts-").FullName;

    [Fact]
    public void WorkingTreeStatus_ReportsAnUnstagedEdit()
    {
        var modFolder = NewModFolder();
        try
        {
            var relativePath = Path.Combine("Test.esp.source", "npc_", "Test.esp", "000001.json");
            var files = new[] { new PristineFile(relativePath, "{\"a\":1}"u8.ToArray()) };
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

            // Plain unstaged edit — never `git add`ed. If WorkingTreeStatus compared the index
            // against HEAD instead of the actual working tree, this would report clean.
            File.WriteAllText(Path.Combine(modFolder, relativePath), "{\"a\":2}");

            var dirty = SourceRepository.WorkingTreeStatus(modFolder);

            Assert.Contains(relativePath.Replace('\\', '/'), dirty);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void WorkingTreeStatus_ReportsNothingForACleanRepo()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new PristineFile("Test.esp.source/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

            var dirty = SourceRepository.WorkingTreeStatus(modFolder);

            Assert.Empty(dirty);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void WorkingTreeStatus_ReportsEmpty_ForAnUntrackedFolder()
    {
        var modFolder = NewModFolder();
        try
        {
            Assert.Empty(SourceRepository.WorkingTreeStatus(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
