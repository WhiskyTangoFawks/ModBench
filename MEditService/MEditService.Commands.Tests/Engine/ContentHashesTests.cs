using System.IO.Compression;
using System.Text;
using MEditService.Commands.Engine;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Tests.Engine;

public sealed class ContentHashesTests
{
    private static readonly DateTime Stamp = new(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private const string SolidSevenZipOfReadmeAndMeshes =
        "N3q8ryccAASFw+b/iQAAAAAAAAAhAAAAAAAAAK4I884BAAdoZWxsb2FiYwAAAIEzB64PzpwGxQkqrtOqhSYoExi7AyVngQOezpXEuqLOOoBYsuFpeARf9NpgbpmG3b+bdRTEowyJRFK25qT5PK7zQvu4KHFnhr9zmjxOQ7xeo5AN1N93PPjN90VRVAkntNgibYgKm0tJNViYtf0deiHHsbke5Gci3AAAABcGDAEJfQAHCwEAASMDAQEFXQAQAAAMgKIKAVdAT/MAAA==";

    private const string WabbajackHashOfNothing = "menYUTfbRu8=";
    private const string WabbajackHashOfHello = "o22fiH2CxyY=";

    [Fact]
    public void AFileHash_IsXxHash64InTheBase64WabbajackWrites()
    {
        Assert.Equal(WabbajackHashOfNothing, FileHash.Of(new MemoryStream()).ToString());
        Assert.Equal(WabbajackHashOfHello, FileHash.Of(new MemoryStream(Encoding.ASCII.GetBytes("hello"))).ToString());
    }

    [Fact]
    public void AZipInstallationFile_YieldsEachEntryByPathWithItsSizeAndHash()
    {
        var repository = new FakeModFolders().WithInstallationFile("mod.zip", Zip(("readme.txt", ""), ("meshes/a.nif", "hello")));

        var entries = new ContentHashes(repository).OfInstallationFile("mod.zip").OrderBy(e => e.Path, StringComparer.Ordinal);

        Assert.Equal(
            [new HashedEntry("meshes/a.nif", 5, FileHash.FromBase64(WabbajackHashOfHello)),
             new HashedEntry("readme.txt", 0, FileHash.FromBase64(WabbajackHashOfNothing))],
            entries);
    }

    [Fact]
    public void ASolidSevenZipInstallationFile_YieldsEachEntry()
    {
        var repository = new FakeModFolders()
            .WithInstallationFile("mod.7z", Convert.FromBase64String(SolidSevenZipOfReadmeAndMeshes));

        var entries = new ContentHashes(repository).OfInstallationFile("mod.7z").OrderBy(e => e.Path, StringComparer.Ordinal).ToList();

        Assert.Equal(["meshes/a.nif", "readme.txt"], entries.Select(e => e.Path));
        Assert.Equal(FileHash.FromBase64(WabbajackHashOfHello), entries[0].Hash);
    }

    [Fact]
    public void AnInstallationFileWhoseSizeAndTimeAreUnchanged_IsNotReadAgain()
    {
        var repository = new FakeModFolders().WithInstallationFile("mod.zip", Zip(("a.txt", "hello")));
        var hashes = new ContentHashes(repository);

        var first = hashes.OfInstallationFile("mod.zip");
        var second = hashes.OfInstallationFile("mod.zip");

        Assert.Equal(first, second);
        Assert.Equal(1, repository.Opens);
    }

    [Fact]
    public void ModFolderFiles_AreHashedByPath()
    {
        var repository = new FakeModFolders().WithFile("meshes/a.nif", "hello", Stamp).WithFile("readme.txt", "", Stamp);

        var hashes = new ContentHashes(repository).OfModFolder("mod");

        Assert.Equal(FileHash.FromBase64(WabbajackHashOfHello), hashes["meshes/a.nif"]);
        Assert.Equal(FileHash.FromBase64(WabbajackHashOfNothing), hashes["readme.txt"]);
    }

    [Fact]
    public void AModFolderFileWhoseSizeAndTimeAreUnchanged_IsNotReadAgain()
    {
        var repository = new FakeModFolders().WithFile("a.txt", "hello", Stamp);
        var hashes = new ContentHashes(repository);

        hashes.OfModFolder("mod");
        hashes.OfModFolder("mod");

        Assert.Equal(1, repository.Opens);
    }

    [Fact]
    public void AModFolderFileWhoseTimeChanged_IsHashedAgain()
    {
        var repository = new FakeModFolders().WithFile("a.txt", "hello", Stamp);
        var hashes = new ContentHashes(repository);
        hashes.OfModFolder("mod");

        repository.WithFile("a.txt", "hellO", Stamp.AddSeconds(1));
        var second = hashes.OfModFolder("mod");

        Assert.Equal(2, repository.Opens);
        Assert.Equal(FileHash.Of(new MemoryStream(Encoding.ASCII.GetBytes("hellO"))), second["a.txt"]);
    }

    [Fact]
    public void AModFolderFileWhoseSizeChanged_IsHashedAgainAtTheSameTime()
    {
        var repository = new FakeModFolders().WithFile("a.txt", "hello", Stamp);
        var hashes = new ContentHashes(repository);
        hashes.OfModFolder("mod");

        repository.WithFile("a.txt", "hello!", Stamp);
        hashes.OfModFolder("mod");

        Assert.Equal(2, repository.Opens);
    }

    private static byte[] Zip(params (string Path, string Text)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, text) in entries)
            {
                using var entry = archive.CreateEntry(path).Open();
                entry.Write(Encoding.ASCII.GetBytes(text));
            }
        }
        return buffer.ToArray();
    }

    private sealed class FakeModFolders : IModFolderRepository
    {
        private readonly Dictionary<string, (byte[] Bytes, DateTime Modified)> _files = [];

        public int Opens { get; private set; }

        public FakeModFolders WithFile(string path, string text, DateTime modified)
        {
            _files[path] = (Encoding.ASCII.GetBytes(text), modified);
            return this;
        }

        public FakeModFolders WithInstallationFile(string path, byte[] bytes)
        {
            _files[path] = (bytes, Stamp);
            return this;
        }

        public IReadOnlyList<ModFile> Files(string modFolder) =>
            [.. _files.Select(f => new ModFile(f.Key, f.Value.Bytes.Length, f.Value.Modified))];

        public ModFile InstallationFile(string path) => Files(path).Single(f => f.Path == path);

        public Stream OpenFile(string modFolder, string path) => Open(path);

        public Stream OpenInstallationFile(string path) => Open(path);

        private MemoryStream Open(string path)
        {
            Opens++;
            return new MemoryStream(_files[path].Bytes);
        }
    }
}
