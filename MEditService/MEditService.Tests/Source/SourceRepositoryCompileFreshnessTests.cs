using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// #449: a tracked plugin whose source has moved past what <c>refs/medit/last-compile/&lt;plugin&gt;</c>
/// parked — "the game can't see your edits yet". Cheap and bounded by dirt (freshness philosophy,
/// <see cref="SourceFreshness"/>): scoped to this plugin's own <c>source/&lt;plugin&gt;/</c> subtree,
/// never the whole repo or record count.
/// </summary>
public sealed class SourceRepositoryCompileFreshnessTests
{
    private const string Plugin = "Test.esp";
    private const string RelPath = "source/Test.esp/npc_/Test.esp/000001.json";

    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-compilefreshness-").FullName;

    private static string TrackOnePlugin(string modFolder, string content = "{}")
    {
        var files = new[] { new PristineFile(RelPath, System.Text.Encoding.UTF8.GetBytes(content)) };
        var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { [Plugin] = "AAAA" });
        SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);
        return Path.Combine(modFolder, RelPath);
    }

    [Fact]
    public void CompileFreshnessOf_RightAfterTrack_IsNotStale()
    {
        var modFolder = NewModFolder();
        try
        {
            TrackOnePlugin(modFolder);

            var freshness = SourceRepository.CompileFreshnessOf(modFolder, Plugin);

            Assert.False(freshness.Stale);
            Assert.NotNull(freshness.LastCompiledAt);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CompileFreshnessOf_WithAnUncommittedWorkingTreeEdit_IsUnanswered()
    {
        var modFolder = NewModFolder();
        try
        {
            var filePath = TrackOnePlugin(modFolder);
            File.WriteAllText(filePath, "{\"edited\":true}");

            var freshness = SourceRepository.CompileFreshnessOf(modFolder, Plugin);

            Assert.True(freshness.Stale);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CompileFreshnessOf_WithANewUncommittedSourceFile_IsUnanswered()
    {
        // The rival this pins against: an implementation that only diffs *tracked* paths (plain
        // `git diff <ref>`, no status check) would miss a brand-new record file that was never
        // `git add`ed — RecordEditService's create path writes straight to disk, no `git add`.
        var modFolder = NewModFolder();
        try
        {
            TrackOnePlugin(modFolder);
            var newFile = Path.Combine(modFolder, "source/Test.esp/npc_/Test.esp/000002.json");
            File.WriteAllText(newFile, "{}");

            var freshness = SourceRepository.CompileFreshnessOf(modFolder, Plugin);

            Assert.True(freshness.Stale);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CompileFreshnessOf_ReturningToTheOriginalContent_IsNotStaleAgain()
    {
        var modFolder = NewModFolder();
        try
        {
            var filePath = TrackOnePlugin(modFolder, "{}");
            File.WriteAllText(filePath, "{\"edited\":true}");
            File.WriteAllText(filePath, "{}");

            var freshness = SourceRepository.CompileFreshnessOf(modFolder, Plugin);

            Assert.False(freshness.Stale);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CompileFreshnessOf_CommittedButNeverRecompiled_IsUnanswered()
    {
        // The rival this pins against: an implementation that only checks working-tree dirt
        // (`git status`) would wrongly answer false here — the working tree is clean (it matches
        // HEAD), but HEAD has moved past the parked ref because the edit was committed without a
        // recompile (ADR-0042's amendment: commit stays ungated, so this is a real, reachable state).
        var modFolder = NewModFolder();
        try
        {
            var filePath = TrackOnePlugin(modFolder);
            File.WriteAllText(filePath, "{\"edited\":true}");
            var gitDir = Path.Combine(modFolder, ".git");
            GitCli.Run(gitDir, modFolder, "add", "-A");
            GitCli.Run(gitDir, modFolder, "commit", "-q", "-m", "edit");

            var freshness = SourceRepository.CompileFreshnessOf(modFolder, Plugin);

            Assert.True(freshness.Stale);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CompileFreshnessOf_AfterAReParkedCompileSnapshot_ClearsAndAdvancesTheTimestamp()
    {
        var modFolder = NewModFolder();
        try
        {
            var filePath = TrackOnePlugin(modFolder);
            var before = SourceRepository.CompileFreshnessOf(modFolder, Plugin).LastCompiledAt;
            File.WriteAllText(filePath, "{\"edited\":true}");
            Assert.True(SourceRepository.CompileFreshnessOf(modFolder, Plugin).Stale);

            SourceRepository.ParkCompileSnapshot(modFolder, Plugin, atRef: null, binarySha256: "DEADBEEF");

            var after = SourceRepository.CompileFreshnessOf(modFolder, Plugin);
            Assert.False(after.Stale);
            Assert.NotNull(after.LastCompiledAt);
            Assert.True(after.LastCompiledAt >= before);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CompileFreshnessOf_ForAnUntrackedFolder_IsNeverStale()
    {
        var modFolder = NewModFolder();
        try
        {
            Directory.CreateDirectory(modFolder);

            var freshness = SourceRepository.CompileFreshnessOf(modFolder, Plugin);

            Assert.False(freshness.Stale);
            Assert.Null(freshness.LastCompiledAt);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CompileFreshnessOf_ForAPluginTrackNeverParkedARefFor_IsNeverStale()
    {
        // #288: a plugin created after Track into an already-tracked mod folder may have no parked
        // ref at all yet — degrade-safe "never stale" rather than a false positive with nothing to
        // compare against (first compile is what parks the ref).
        var modFolder = NewModFolder();
        try
        {
            TrackOnePlugin(modFolder);

            var freshness = SourceRepository.CompileFreshnessOf(modFolder, "NeverTracked.esp");

            Assert.False(freshness.Stale);
            Assert.Null(freshness.LastCompiledAt);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CompileFreshnessOf_ForAPluginNameWithSpacesAndBrackets_ScopesCorrectlyDespiteGitPathspecMagicChars()
    {
        // #459's own lesson, applied here: '[' and ']' are git pathspec glob magic characters. A
        // pathspec built without :(literal) would silently fail to match this plugin's own source
        // folder, or match something else, either of which reads as "never stale" no matter what
        // actually changed.
        const string bracketedPlugin = "[ARRETH] FGEP-DE.esp";
        var modFolder = NewModFolder();
        try
        {
            var relPath = $"source/{bracketedPlugin}/npc_/{bracketedPlugin}/000001.json";
            var files = new[] { new PristineFile(relPath, "{}"u8.ToArray()) };
            var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { [bracketedPlugin] = "AAAA" });
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);

            Assert.False(SourceRepository.CompileFreshnessOf(modFolder, bracketedPlugin).Stale);

            File.WriteAllText(Path.Combine(modFolder, relPath), "{\"edited\":true}");

            Assert.True(SourceRepository.CompileFreshnessOf(modFolder, bracketedPlugin).Stale);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
