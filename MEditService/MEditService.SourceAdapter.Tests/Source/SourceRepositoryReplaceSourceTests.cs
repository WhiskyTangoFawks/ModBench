using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryReplaceSourceTests : IDisposable
{
    private const string Plugin = "A.esp";
    private const string Sha = "ABCDEF0123";
    private static readonly PluginAddress Address = new(Plugin, "TestMod");
    private readonly ScratchDirectory _modFolder = new("medit-replace-source-");

    public SourceRepositoryReplaceSourceTests() =>
        SourceRepository.Track(_modFolder, [([File("npc_/A.esp/000001.json", "{\"was\":1}")], new DecompiledPlugin(Plugin, null))]);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void ReplaceSourceFrom_LeavesExactlyTheNewFiles_AndParksTheBinaryAlone()
    {
        Repository.ReplaceSourceFrom(Address, [File("npc_/A.esp/000002.json", "{\"now\":2}")], Sha);

        Assert.Equal(["npc_/A.esp/000002.json"], FilesUnderRoot());
        Assert.Equal([Sha], Repository.LastWrittenBinarySha256s(Address));
        Assert.Equal(" D plugin-source/A.esp/npc_/A.esp/000001.json", Git("status", "--porcelain", "--untracked-files=no").TrimEnd('\n'));
    }

    [Fact]
    public void ReplaceSourceFrom_TakesTheDoorsTree_SoItsRootDocumentLandsAsTheHeader()
    {
        Repository.ReplaceSourceFrom(Address, [new TreeFile("RecordData.json", "{}"u8.ToArray())], Sha);

        Assert.Equal(["000000_A.esp.json"], FilesUnderRoot());
    }

    [Fact]
    public void ReplaceSourceFrom_WritesOnlyWhatDiffers_SoAnUnchangedFileKeepsItsStamp_AndAnEmptiedDirectoryGoes()
    {
        Repository.ReplaceSourceFrom(
            Address, [File("npc_/A.esp/000001.json", "{\"was\":1}"), File("armo/A.esp/000003.json", "{\"a\":3}"), File("weap/A.esp/000004.json", "{}")], Sha);
        var unchanged = Path.Combine(Root, "npc_", "A.esp", "000001.json");
        var rewritten = Path.Combine(Root, "armo", "A.esp", "000003.json");
        var longAgo = new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        System.IO.File.SetLastWriteTimeUtc(unchanged, longAgo);

        Repository.ReplaceSourceFrom(
            Address, [File("npc_/A.esp/000001.json", "{\"was\":1}"), File("armo/A.esp/000003.json", "{\"a\":33}")], Sha);

        Assert.Equal(longAgo, System.IO.File.GetLastWriteTimeUtc(unchanged));
        Assert.Equal("{\"a\":33}", System.IO.File.ReadAllText(rewritten));
        Assert.Equal(["armo/A.esp/000003.json", "npc_/A.esp/000001.json"], FilesUnderRoot());
        Assert.False(Directory.Exists(Path.Combine(Root, "weap")));
    }

    [Fact]
    public void ReplaceSourceFrom_WhenItFails_LeavesAFileAnotherProgramPutInADirectoryItMade_AndNamesTheDirectory()
    {
        var theirs = Path.Combine(Root, "armo", "theirs.txt");

        var failure = FailAfterWritingWhile($"echo theirs > '{theirs}'", [File("npc_/A.esp/000001.json", "{\"was\":1}"), File("armo/A.esp/000003.json", "{}")]);

        Assert.Equal("theirs", System.IO.File.ReadAllText(theirs).Trim());
        Assert.Contains("armo — holds something this change did not write", failure.Message.Replace('\\', '/'));
        Assert.False(System.IO.File.Exists(Path.Combine(Root, "armo", "A.esp", "000003.json")));
    }

    [Fact]
    public void ReplaceSourceFrom_WhenItFails_LeavesAFileAnotherProgramChangedAfterItReplacedIt_AndNamesIt()
    {
        var replaced = Path.Combine(Root, "npc_", "A.esp", "000001.json");

        var failure = FailAfterWritingWhile($"echo theirs > '{replaced}'", [File("npc_/A.esp/000001.json", "{\"now\":2}")]);

        Assert.Equal("theirs", System.IO.File.ReadAllText(replaced).Trim());
        Assert.Contains("000001.json — changed by something else", failure.Message);
    }

    [Fact]
    public void ReplaceSourceFrom_WhenItFails_DoesNotPutBackAFileAnotherProgramRemovedAfterItReplacedIt()
    {
        var replaced = Path.Combine(Root, "npc_", "A.esp", "000001.json");

        var failure = FailAfterWritingWhile($"rm '{replaced}'", [File("npc_/A.esp/000001.json", "{\"now\":2}")]);

        Assert.False(System.IO.File.Exists(replaced));
        Assert.Contains("000001.json — removed by something else", failure.Message);
    }

    [Fact]
    public void ReplaceSourceFrom_WhenItFails_LeavesAFileAnotherProgramWroteWhereItRemovedOne_AndNamesIt()
    {
        var removed = Path.Combine(Root, "npc_", "A.esp", "000001.json");

        var failure = FailAfterWritingWhile($"mkdir -p '{Path.GetDirectoryName(removed)}'\necho theirs > '{removed}'", [File("armo/A.esp/000003.json", "{}")]);

        Assert.Equal("theirs", System.IO.File.ReadAllText(removed).Trim());
        Assert.Contains("000001.json — written by something else", failure.Message);
    }

    [Fact]
    public void ReplaceSourceFrom_WhenItFails_PutsBackADirectoryItEmptiedAndAnotherProgramThenFilled_NamingNothing()
    {
        var theirs = Path.Combine(Root, "npc_", "A.esp", "theirs.txt");

        var failure = Assert.ThrowsAny<InvalidOperationException>(() => FailAfterWriting(
            $"echo theirs > '{theirs}'", [File("npc_/A.esp/000002.json", "{}")]));

        Assert.Equal("theirs", System.IO.File.ReadAllText(theirs).Trim());
        Assert.Equal("{\"was\":1}", System.IO.File.ReadAllText(Path.Combine(Root, "npc_", "A.esp", "000001.json")));
        Assert.DoesNotContain("Not put back", failure.Message);
    }

    [Fact]
    public void ReplaceSourceFrom_WhenOneRollbackStepFails_StillPutsBackTheRest_AndKeepsTheCause()
    {
        Repository.ReplaceSourceFrom(Address, [File("npc_/A.esp/000001.json", "{\"was\":1}"), File("npc_/A.esp/000002.json", "{\"was\":2}")], Sha);
        var first = Path.Combine(Root, "npc_", "A.esp", "000001.json");
        var second = Path.Combine(Root, "npc_", "A.esp", "000002.json");

        var failure = FailAfterWritingWhile(
            $"mkdir -p '{second}'\necho theirs > '{second}/theirs.txt'", [File("armo/A.esp/000003.json", "{}")]);

        Assert.Contains("000002.json — could not be restored", failure.Message);
        Assert.NotNull(failure.InnerException);
        Assert.Equal("{\"was\":1}", System.IO.File.ReadAllText(first));
    }

    private Exception FailAfterWritingWhile(string script, TreeFile[] files) =>
        Assert.ThrowsAny<IOException>(() => FailAfterWriting(script, files));

    private void FailAfterWriting(string script, TreeFile[] files)
    {
        GitHooks.Write(_modFolder, "reference-transaction", $"[ \"$1\" = prepared ] || exit 0\n{script}\nexit 1");
        Repository.ReplaceSourceFrom(Address, files, Sha);
    }

    [Fact]
    public void ReplaceSourceFrom_AFileThatCannotBeWritten_LeavesTheSourceAndTheRefAsTheyWere()
    {
        var lastWrittenBefore = Repository.LastWrittenBinarySha256s(Address);

        TreeFile[] secondFileNeedsADirectoryTheFirstOccupies = [File("npc_", "{}"), File("npc_/A.esp/000002.json", "{}")];

        Assert.ThrowsAny<IOException>(() => Repository.ReplaceSourceFrom(
            Address, secondFileNeedsADirectoryTheFirstOccupies, Sha));

        Assert.Equal(["npc_/A.esp/000001.json"], FilesUnderRoot());
        Assert.Equal("{\"was\":1}", System.IO.File.ReadAllText(Path.Combine(Root, "npc_", "A.esp", "000001.json")));
        Assert.Equal(lastWrittenBefore, Repository.LastWrittenBinarySha256s(Address));
    }

    [Fact]
    public void ReplaceSourceFrom_ParksTheBinaryItWasMadeFrom_NamedForDecompile()
    {
        Repository.ReplaceSourceFrom(Address, [File("npc_/A.esp/000002.json", "{\"now\":2}")], Sha);

        var parked = LastWriteRecord.RefOfTheOnlyPlugin(_modFolder);
        Assert.Equal([Sha], Repository.LastWrittenBinarySha256s(Address));
        Assert.Equal("Decompile: A.esp", Git("log", "-1", "--format=%s", parked).Trim());
    }

    [Fact]
    public void ReplaceSourceFrom_OnABranchWithNoCommitYetWhereGitRefusesToParkAfterEveryFileIsWritten_LeavesTheSourceAndTheRefAsTheyWere()
    {
        var lastWrittenBefore = Repository.LastWrittenBinarySha256s(Address);
        Git("checkout", "-q", "--orphan", "unborn");

        Assert.ThrowsAny<InvalidOperationException>(() => Repository.ReplaceSourceFrom(
            Address, [File("npc_/A.esp/000002.json", "{}")], Sha));

        Assert.Equal(["npc_/A.esp/000001.json"], FilesUnderRoot());
        Assert.Equal("{\"was\":1}", System.IO.File.ReadAllText(Path.Combine(Root, "npc_", "A.esp", "000001.json")));
        Assert.Equal(lastWrittenBefore, Repository.LastWrittenBinarySha256s(Address));
    }

    [Fact]
    public void ReplaceSourceFrom_IntoAModFolderAnotherToolRemoved_NamesTheMissingRepository_AndRecreatesNothing()
    {
        var repository = Repository;
        Directory.Delete(_modFolder, recursive: true);

        var refused = Assert.Throws<InvalidOperationException>(() => repository.ReplaceSourceFrom(
            Address, [File("npc_/A.esp/000002.json", "{}")], Sha));

        Assert.Contains("holds no repository", refused.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(_modFolder));
    }

    [Fact]
    public void AGitStep_InAModFolderAnotherToolRemoved_FailsNamingTheFolder_NotGit()
    {
        var repository = Repository;
        Directory.Delete(_modFolder, recursive: true);

        var failure = Assert.ThrowsAny<Exception>(() => repository.WriteBinary(Address, Sha, () => { }));

        Assert.IsNotType<GitUnavailableException>(failure);
        Assert.Contains(_modFolder, failure.Message, StringComparison.Ordinal);
    }

    private SourceRepository Repository =>
        SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4) ?? throw new InvalidOperationException("Expected the fixture tracked.");

    private string Root => PluginSourceRoot.In(_modFolder, Plugin);

    private static TreeFile File(string underRoot, string text) =>
        new(underRoot, System.Text.Encoding.UTF8.GetBytes(text));

    private string[] FilesUnderRoot() =>
        [.. Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(Root, path).Replace('\\', '/'))
            .Order(StringComparer.Ordinal)];

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryReplaceSourceWithoutGitTests : IDisposable
{
    private readonly ScratchDirectory _modFolder = new("medit-replace-source-nogit-");

    public SourceRepositoryReplaceSourceWithoutGitTests() =>
        PluginBaselines.Track(_modFolder,
            [new TreeFile("plugin-source/A.esp/npc_/A.esp/000001.json", "{\"was\":1}"u8.ToArray())]);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void ReplaceSourceFrom_WithGitGoneFromPathAfterTheUpFrontCheck_ThrowsTheOsReason_AndLeavesTheSourceAsItWas()
    {
        var repository = SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4) ?? throw new InvalidOperationException("Expected the fixture tracked.");
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            Assert.Throws<System.ComponentModel.Win32Exception>(() => repository.ReplaceSourceFrom(
                new PluginAddress("A.esp", "TestMod"), [new TreeFile("npc_/A.esp/000002.json", "{}"u8.ToArray())], "ABCDEF0123"));
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }

        var root = PluginSourceRoot.In(_modFolder, "A.esp");
        Assert.Equal(
            [Path.Combine(root, "npc_", "A.esp", "000001.json")],
            Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories));
    }
}
