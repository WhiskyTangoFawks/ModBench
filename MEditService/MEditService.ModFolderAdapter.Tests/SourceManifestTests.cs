using MEditService.TestSupport;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class SourceManifestTests : IDisposable
{
    private static readonly DateTime LongAgo = new(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private readonly ScratchDirectory _source = new("source-manifest-");
    private readonly ModFolderRepository _repository = new(TimeProvider.System);

    public void Dispose() => _source.Dispose();

    private Manifest? Read(string? sourceFolder = null) =>
        _repository.ReadSourceManifest(sourceFolder ?? _source).Holds(out var manifest, out var why) ? manifest : throw new Xunit.Sdk.XunitException(why);

    private string Why() => _repository.ReadSourceManifest(_source).Holds(out _, out var why) ? throw new Xunit.Sdk.XunitException("It read.") : why;

    private static readonly Manifest Built = new(
        [new ManifestPackage.SourceRepository("Mod", IsSubmodule: true)],
        [new ManifestFile("Mod - Main.ba2", new PackageEntry.Held()), new ManifestFile("Mod.esp", new PackageEntry.Held())],
        "1.0")
    {
        Output = "The Mod",
        Exclude = ["docs", "a.esp"],
        Archives = [new ManifestArchive("Mod - Main.ba2", ["meshes/a.nif", "meshes/b.nif"]), new ManifestArchive("Mod - Textures.ba2", ["textures/a.dds"])],
    };

    [Fact]
    public void ASourceModsManifest_SitsAtItsRepositorysRoot_NamedForItsOutput_WithALineForItsOutputItsExclusionsAndEachArchive()
    {
        Assert.True(_repository.WriteSourceManifest(_source, Built));

        Assert.Equal(["The Mod.manifest.json"], Directory.GetFiles(_source).Select(Path.GetFileName));
        Assert.Equal(
            "{\n"
            + "\"output\": \"The Mod\",\n"
            + "\"packages\": [\n{\"submodule\":\"Mod\",\"version\":\"1.0\"}\n],\n"
            + "\"exclude\": [\"a.esp\",\"docs\"],\n"
            + "\"archives\": {\n"
            + "\"Mod - Main.ba2\": [\"meshes/a.nif\",\"meshes/b.nif\"],\n"
            + "\"Mod - Textures.ba2\": [\"textures/a.dds\"]\n"
            + "},\n"
            + "\"files\": [\n"
            + "{\"path\":\"Mod - Main.ba2\"},\n"
            + "{\"path\":\"Mod.esp\"}\n"
            + "]\n"
            + "}\n",
            File.ReadAllText(Path.Combine(_source, "The Mod.manifest.json")));
    }

    [Fact]
    public void ASourceModsManifest_ReadsBackAsWritten()
    {
        _repository.WriteSourceManifest(_source, Built);

        var read = Read();

        Assert.NotNull(read);
        Assert.Equal((Built.Output, Built.Packages[0], Built.Version), (read.Output, read.Packages[0], read.Version));
        Assert.Equal(["a.esp", "docs"], read.Exclude);
        Assert.Equal(
            [("Mod - Main.ba2", "meshes/a.nif|meshes/b.nif"), ("Mod - Textures.ba2", "textures/a.dds")],
            read.Archives.Select(archive => (archive.Path, string.Join('|', archive.Files))));
        Assert.Equal(Built.Files, read.Files);
    }

    [Fact]
    public void ASourceModsManifestNamingNoFile_IsItsOutputAndAnEmptyFileList()
    {
        _repository.WriteSourceManifest(_source, new Manifest([], []) { Output = "Mod" });

        Assert.Equal("{\n\"output\": \"Mod\",\n\"files\": []\n}\n", File.ReadAllText(Path.Combine(_source, "Mod.manifest.json")));
    }

    [Fact]
    public void ARepositoryWithNoManifestAtItsRoot_HasNone()
    {
        Directory.CreateDirectory(Path.Combine(_source, "assets"));
        File.WriteAllText(Path.Combine(_source, "assets", "Mod.manifest.json"), "{}");

        Assert.Null(Read());
        Assert.Null(Read(Path.Combine(_source, "absent")));
    }

    [Fact]
    public void ARepositoryHoldingTwoManifests_IsUnreadable_NamingBoth()
    {
        _repository.WriteSourceManifest(_source, new Manifest([], []) { Output = "A" });
        File.Copy(Path.Combine(_source, "A.manifest.json"), Path.Combine(_source, "B.manifest.json"));

        Assert.Equal("its repository holds two manifests, 'A.manifest.json' and 'B.manifest.json'", Why());
    }

    [Theory]
    [InlineData("{\"files\": []}", "its manifest names no output folder")]
    [InlineData("{\"output\": \"a/b\", \"files\": []}", "its manifest's output 'a/b' is not a folder name")]
    [InlineData("{\"output\": \"..\", \"files\": []}", "its manifest's output '..' is not a folder name")]
    [InlineData("{\"output\": \"A\", \"exclude\": [\"../a.esp\"], \"files\": []}", "its manifest's 'exclude' names '../a.esp', which is not a path in the folder")]
    [InlineData("{\"output\": \"A\", \"archives\": {\"A.ba2\": [\"/a.nif\"]}, \"files\": []}", "its manifest's 'archives' names '/a.nif', which is not a path in the folder")]
    [InlineData("{\"output\": \"A\", \"archives\": {\"../A.ba2\": []}, \"files\": []}", "its manifest's 'archives' names '../A.ba2', which is not a path in the folder")]
    [InlineData("{\"output\": \"A\", \"archives\": [\"A.ba2\"], \"files\": []}", "its manifest cannot be read")]
    [InlineData("{\"output\": \"A\", \"exclude\": \"a.esp\", \"files\": []}", "its manifest cannot be read")]
    [InlineData("[\"output\"]", "its manifest cannot be read")]
    [InlineData("{\"output\": 1, \"files\": []}", "its manifest cannot be read")]
    [InlineData("{\"output\": \"A\", \"archives\": {\"a\\\\b.ba2\": []}, \"files\": []}", "its manifest's 'archives' names 'a\\b.ba2', which is not a path in the folder")]
    public void AManifestWhoseOutputExclusionsOrArchivesAreNotInTheFolder_IsUnreadable_SayingWhy(string text, string why)
    {
        File.WriteAllText(Path.Combine(_source, "A.manifest.json"), text);

        Assert.StartsWith(why, Why(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("{\"output\": \"A\", \"deltas\": [], \"files\": []}", "its manifest holds 'deltas', which Modbench does not read")]
    [InlineData("{\"output\": \"A\", \"packages\": [{\"repository\": \"A\", \"remote\": \"x\"}], \"files\": []}", "its manifest's package 1 holds 'remote', which Modbench does not read")]
    [InlineData("{\"output\": \"A\", \"files\": [{\"path\": \"a.esp\"}, {\"path\": \"b.esp\", \"hash\": \"x\"}]}", "its manifest's file 2 holds 'hash', which Modbench does not read")]
    [InlineData("{\"output\": \"A\", \"steps\": [{\"task\": \"Zip\", \"env\": {}}], \"files\": []}", "its manifest's step 1 holds 'env', which Modbench does not read")]
    public void AManifestHoldingAKeyModbenchDoesNotRead_IsUnreadable_NamingIt_SoNoWriteDropsIt(string text, string why)
    {
        File.WriteAllText(Path.Combine(_source, "A.manifest.json"), text);

        Assert.Equal(why, Why());
    }

    [Fact]
    public void AManifestNotNamedForItsOutput_IsUnreadable_NamingBoth()
    {
        File.WriteAllText(Path.Combine(_source, "Old.manifest.json"), "{\"output\": \"New\", \"files\": []}");

        Assert.Equal(
            "its manifest 'Old.manifest.json' is not named for its output folder 'New'",
            Why());
    }

    [Fact]
    public void AFolderNamedAsAManifest_IsNoManifest()
    {
        Directory.CreateDirectory(Path.Combine(_source, "A.manifest.json"));

        Assert.Null(Read());
    }

    [Fact]
    public void AModFoldersManifest_IsRemovedAndAnswered_UnlessTheRepositoryIsThatFolder_HoweverItsPathIsSpelled()
    {
        var modFolder = Directory.CreateDirectory(Path.Combine(_source, "mods", "Mod")).FullName;
        File.WriteAllText(Path.Combine(modFolder, "Mod.manifest.json"), "held");

        Assert.Null(_repository.RemoveManifest(modFolder, modFolder + Path.DirectorySeparatorChar));
        var removed = _repository.RemoveManifest(modFolder, Path.Combine(_source, "source", "Mod"));

        Assert.Equal(("Mod.manifest.json", "held"), (removed?.Name, System.Text.Encoding.UTF8.GetString(removed?.Text ?? [])));
        Assert.False(File.Exists(Path.Combine(modFolder, "Mod.manifest.json")));
    }

    [Fact]
    public void AManifestWithAnotherOutput_ReplacesTheOneThere_UnderItsNewName()
    {
        _repository.WriteSourceManifest(_source, Built);

        Assert.True(_repository.WriteSourceManifest(_source, Built with { Output = "Renamed" }));

        Assert.Equal(["Renamed.manifest.json"], Directory.GetFiles(_source).Select(Path.GetFileName));
        Assert.Equal("Renamed", Read()?.Output);
    }

    [Fact]
    public void AManifestOfTheTextAlreadyThere_WritesNothing()
    {
        _repository.WriteSourceManifest(_source, Built);
        var path = Path.Combine(_source, "The Mod.manifest.json");
        File.SetLastWriteTimeUtc(path, LongAgo);

        Assert.False(_repository.WriteSourceManifest(_source, Built));

        Assert.Equal(LongAgo, File.GetLastWriteTimeUtc(path));
    }

    [Fact]
    public void ASourceModsManifest_IsSpelledAsItIsWritten_UnderTheNameItIsWrittenAs()
    {
        var spelled = _repository.SpellSourceManifest(Built);
        _repository.WriteSourceManifest(_source, Built);

        Assert.Equal("The Mod.manifest.json", spelled.Name);
        Assert.Equal(File.ReadAllBytes(Path.Combine(_source, spelled.Name)), spelled.Text);
    }
}
