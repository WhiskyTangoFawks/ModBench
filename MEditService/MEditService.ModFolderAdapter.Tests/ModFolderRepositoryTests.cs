using MEditService.TestSupport;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ModFolderRepositoryTests : IDisposable
{
    private static readonly DateTime LongAgo = new(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private readonly ScratchDirectory _scratch = new("modfolder-adapter-");
    private readonly ModFolderRepository _repository = new();
    private readonly string _root;

    public ModFolderRepositoryTests() => _root = Directory.CreateDirectory(Path.Combine(_scratch, "mod")).FullName;

    public void Dispose() => _scratch.Dispose();

    [Fact]
    public void Hashes_HashEachFileByItsForwardSlashPath_AlikeForAlikeBytes()
    {
        Write("readme.txt", "abc");
        Write(Path.Combine("meshes", "deep", "a.nif"), "hello");
        Write("b.nif", "hello");

        var hashes = _repository.Hashes(_root);

        Assert.Equal(["b.nif", "meshes/deep/a.nif", "readme.txt"], hashes.Keys.Order(StringComparer.Ordinal));
        Assert.Equal(hashes["b.nif"], hashes["meshes/deep/a.nif"]);
        Assert.NotEqual(hashes["b.nif"], hashes["readme.txt"]);
    }

    [Fact]
    public void DeleteFile_RemovesTheFile_AndAFileAlreadyGoneIsDone()
    {
        Write("a.nif", "a");

        _repository.DeleteFile(_root, "a.nif");
        _repository.DeleteFile(_root, "a.nif");

        Assert.Empty(Directory.GetFiles(_root));
    }

    [Fact]
    public void ExcludedName_IsTheNameWithTheExclusionMarkAfterIt() =>
        Assert.Equal("a.esp.excluded", _repository.ExcludedName("a.esp", ".excluded"));

    [Fact]
    public void DataFolderExists_AnswersWhetherTheFolderIsThere()
    {
        Assert.True(_repository.DataFolderExists(_root));
        Assert.False(_repository.DataFolderExists(Path.Combine(_root, "no-such-data")));
    }

    [Fact]
    public void ALeftoverOfAKilledWrite_IsNoFileOfTheMod()
    {
        Write("a.txt", "hello");
        TempLeftover.DeadWriters(_root);
        Write(Path.Combine(".medit_tmp_1_dir", "mod.esp"), "half");

        Assert.Equal(["a.txt"], _repository.Hashes(_root).Keys);
        Assert.Equal(["a.txt"], _repository.FilePaths(_root));
    }

    public static TheoryData<string, Func<string, string>, bool> Leftovers => new()
    {
        { "a file whose writer is gone", TempLeftover.DeadWriters, false },
        { "a folder whose writer is gone", folder => Directory.CreateDirectory(Path.Combine(folder, ".medit_tmp_2000000000_dir")).FullName, false },
        { "a file whose writer runs", TempLeftover.RunningWriters, true },
        { "a file whose name carries no writer", folder => WrittenAt(Path.Combine(folder, ".medit_tmp_nowriter.tmp")), true },
    };

    [Theory]
    [MemberData(nameof(Leftovers))]
    public void AWrite_RemovesALeftover_OnlyWhenItsWriterIsGone(string _, Func<string, string> leftoverIn, bool kept)
    {
        var leftover = leftoverIn(_root);

        _repository.WriteFile(_root, "mod.ba2", content => content.Write("new"u8));

        Assert.Equal(kept, Path.Exists(leftover));
    }

    private static string WrittenAt(string path)
    {
        File.WriteAllText(path, "half");
        return path;
    }

    [Fact]
    public void AWrite_WhoseLeftoverCannotBeRemoved_Fails()
    {
        using var stuck = TempLeftover.Undeletable(_root);

        Assert.ThrowsAny<SystemException>(() => _repository.WriteFile(_root, "mod.ba2", content => content.Write("new"u8)));
        Assert.False(File.Exists(Path.Combine(_root, "mod.ba2")));
    }

    [Fact]
    public void OpenFile_ReadsTheFileAtThePathUnderTheFolder()
    {
        Write("scripts/a.pex", "bytes");

        using var content = new StreamReader(_repository.OpenFile(_root, "scripts/a.pex"));

        Assert.Equal("bytes", content.ReadToEnd());
    }

    [Theory]
    [InlineData("mod.ba2", "old archive, longer than the new one", true)]
    [InlineData("mod.ba2", "old", true)]
    [InlineData("mod.ba2", "new", false)]
    [InlineData("another.ba2", "old", false)]
    public void WriteFile_PutsTheStreamsBytesAtThePath_SayingWhetherItReplacedOtherBytes(string pathThere, string there, bool replaced)
    {
        Write(pathThere, there);

        Assert.Equal(replaced, _repository.WriteFile(_root, "mod.ba2", content => content.Write("new"u8)));

        Assert.Equal("new", File.ReadAllText(Path.Combine(_root, "mod.ba2")));
    }

    [Fact]
    public void WriteFile_OfTheBytesAlreadyThere_LeavesTheFileUntouched()
    {
        Write("mod.ba2", "same");
        File.SetLastWriteTimeUtc(Path.Combine(_root, "mod.ba2"), LongAgo);

        _repository.WriteFile(_root, "mod.ba2", content => content.Write("same"u8));

        Assert.Equal(LongAgo, File.GetLastWriteTimeUtc(Path.Combine(_root, "mod.ba2")));
        Assert.Equal(["mod.ba2"], Directory.GetFiles(_root).Select(Path.GetFileName));
    }

    [Theory]
    [InlineData("mods/New", "a.txt")]
    [InlineData("", "archives/mod.ba2")]
    public void WriteFile_CreatesTheFoldersItNeeds(string folder, string path)
    {
        _repository.WriteFile(Path.Combine(_root, folder), path, content => content.Write("new"u8));

        Assert.Equal("new", File.ReadAllText(Path.Combine(_root, folder, path)));
    }

    [Fact]
    public void WriteFile_WhenTheWriteThrows_LeavesTheFolderAsItWas()
    {
        Write("mod.ba2", "old");

        Assert.Throws<InvalidDataException>(() => _repository.WriteFile(_root, "mod.ba2", content =>
        {
            content.Write("half"u8);
            throw new InvalidDataException("cannot");
        }));

        Assert.Equal("old", File.ReadAllText(Path.Combine(_root, "mod.ba2")));
        Assert.Equal(["mod.ba2"], Directory.GetFiles(_root).Select(Path.GetFileName));
    }

    [Fact]
    public void WriteFile_WhileWriting_HoldsTheBytesInAHiddenFileOfNoModExtension()
    {
        string[] during = [];

        _repository.WriteFile(_root, "mod.ba2", content =>
        {
            content.Write("new"u8);
            during = [.. Directory.GetFiles(_root).Select(Path.GetFileName).OfType<string>()];
        });

        var held = Assert.Single(during);
        Assert.StartsWith(".medit_tmp_", held);
        Assert.EndsWith(".tmp", held);
    }

    [Fact]
    public void WriteFile_WhenTheWriteThrows_CreatesNoFolderForThePath()
    {
        Assert.Throws<InvalidDataException>(() => _repository.WriteFile(_root, "archives/mod.ba2", _ => throw new InvalidDataException("cannot")));

        Assert.Empty(Directory.GetFileSystemEntries(_root));
    }

    private void Write(string relative, string text)
    {
        var path = Path.Combine(_root, relative);
        new FileInfo(path).Directory?.Create();
        File.WriteAllText(path, text);
    }
}
