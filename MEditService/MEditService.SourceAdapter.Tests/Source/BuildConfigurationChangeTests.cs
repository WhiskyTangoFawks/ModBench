using System.Text;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class BuildConfigurationChangeTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-build-configuration-");
    private readonly string _sourceFolder;

    public BuildConfigurationChangeTests() => _sourceFolder = Directory.CreateDirectory(Path.Combine(_root, TestMod.Name)).FullName;

    public void Dispose() => _root.Dispose();

    [Fact]
    public void ANewOutput_IsWrittenIntoTheWorkingTree_AndNothingIsCommitted()
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, "Old Name", [], []));

        Assert.Null(TestAdapters.Source().ChangeBuildConfiguration(_sourceFolder, new BuildConfigurationChange("New Name", [], [])));

        Assert.Equal("{\n  \"output\": \"New Name\"\n}\n", BuildJson());
        Assert.Equal(" M build.json\n", Git("status", "--porcelain"));
    }

    [Fact]
    public void AWrite_RemovesALeftoverOfAWriterThatIsGone_BesideIt()
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, "Old Name", [], []));
        var leftover = TempLeftover.DeadWriters(_sourceFolder);

        Assert.Null(TestAdapters.Source().ChangeBuildConfiguration(_sourceFolder, new BuildConfigurationChange("New Name", [], [])));

        Assert.False(File.Exists(leftover));
    }

    [Theory]
    [InlineData("{\"output\": \"Mod\"}", new[] { "textures/b.dds", "meshes" }, new string[0],
        "{\n  \"output\": \"Mod\",\n  \"exclude\": [\n    \"meshes\",\n    \"textures/b.dds\"\n  ]\n}\n")]
    [InlineData("{\"output\": \"Mod\", \"exclude\": [\"textures/b.dds\"]}", new[] { "Textures/B.dds", "a.esp", "Z.esp" }, new string[0],
        "{\n  \"output\": \"Mod\",\n  \"exclude\": [\n    \"a.esp\",\n    \"textures/b.dds\",\n    \"Z.esp\"\n  ]\n}\n")]
    [InlineData("{\"output\": \"Mod\", \"exclude\": [\"a.esp\", \"textures/b.dds\"]}", new string[0], new[] { "Textures/B.dds" },
        "{\n  \"output\": \"Mod\",\n  \"exclude\": [\n    \"a.esp\"\n  ]\n}\n")]
    [InlineData("{\"output\": \"Mod\", \"exclude\": [\"a.esp\"]}", new string[0], new[] { "a.esp", "never.esp" },
        "{\n  \"output\": \"Mod\"\n}\n")]
    public void AnExclusion_IsAddedOrRemovedByPathWithoutCase_TheRestKeptSorted(
        string before, string[] exclude, string[] include, string after)
    {
        WriteBuildJson(before);

        Assert.Null(TestAdapters.Source().ChangeBuildConfiguration(_sourceFolder, new BuildConfigurationChange(null, exclude, include)));

        Assert.Equal(after, BuildJson());
    }

    [Fact]
    public void AChange_KeepsWhatElseTheConfigurationSays()
    {
        WriteBuildJson("{\"output\": \"Mod\", \"archives\": [{\"name\": \"Mod - Main.ba2\"}]}");

        Assert.Null(TestAdapters.Source().ChangeBuildConfiguration(_sourceFolder, new BuildConfigurationChange("Other", ["a.esp"], [])));

        Assert.Equal(
            "{\n  \"output\": \"Other\",\n  \"archives\": [\n    {\n      \"name\": \"Mod - Main.ba2\"\n    }\n  ],\n  \"exclude\": [\n    \"a.esp\"\n  ]\n}\n",
            BuildJson());
    }

    [Fact]
    public void AFolderWithNoConfiguration_RefusesAsUnreadable_AndGetsNone()
    {
        var failure = TestAdapters.Source().ChangeBuildConfiguration(_sourceFolder, new BuildConfigurationChange("Other", [], []));

        Assert.Contains(_sourceFolder, Assert.IsType<SourceFailure.Unreadable>(failure).Reason, StringComparison.Ordinal);
        Assert.False(File.Exists(BuildJsonPath));
    }

    [Theory]
    [InlineData("{\"output\": ")]
    [InlineData("[\"output\"]")]
    [InlineData("{\"output\": \"Mod\", \"exclude\": [1]}")]
    public void AConfigurationThatIsNotReadable_RefusesAsUnreadable_AndIsLeftAsItWas(string before)
    {
        WriteBuildJson(before);

        var failure = TestAdapters.Source().ChangeBuildConfiguration(_sourceFolder, new BuildConfigurationChange("Other", [], []));

        Assert.Contains(_sourceFolder, Assert.IsType<SourceFailure.Unreadable>(failure).Reason, StringComparison.Ordinal);
        Assert.Equal(before, BuildJson());
    }

    [Theory]
    [InlineData("Sub/Name", new string[0], new string[0])]
    [InlineData("..", new string[0], new string[0])]
    [InlineData(null, new[] { "../outside.dds" }, new string[0])]
    [InlineData(null, new[] { "textures\\a.dds" }, new string[0])]
    [InlineData(null, new string[0], new[] { "/rooted.esp" })]
    public void AChangeOutsideTheMod_RefusesAsOutsideTheMod_AndLeavesTheConfigurationAsItWas(string? output, string[] exclude, string[] include)
    {
        const string before = "{\"output\": \"Mod\"}";
        WriteBuildJson(before);

        var failure = TestAdapters.Source().ChangeBuildConfiguration(_sourceFolder, new BuildConfigurationChange(output, exclude, include));

        Assert.IsType<SourceFailure.OutsideTheMod>(failure);
        Assert.Equal(before, BuildJson());
    }

    [PosixFact]
    public void AConfigurationTheDiskWillNotLetBeWritten_IsInaccessible_AndIsLeftAsItWas()
    {
        WriteBuildJson("{\"output\": \"Old Name\"}");
        FileModes.Set(_sourceFolder, "555");
        SourceFailure? failure;
        try
        {
            failure = TestAdapters.Source().ChangeBuildConfiguration(_sourceFolder, new BuildConfigurationChange("New Name", [], []));
        }
        finally
        {
            FileModes.Set(_sourceFolder, "755");
        }

        Assert.IsType<SourceFailure.Inaccessible>(failure);
        Assert.Equal("{\"output\": \"Old Name\"}", BuildJson());
    }

    private string BuildJsonPath => Path.Combine(_sourceFolder, "build.json");

    private string BuildJson() => File.ReadAllText(BuildJsonPath, Encoding.UTF8);

    private void WriteBuildJson(string text) => File.WriteAllText(BuildJsonPath, text);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_sourceFolder, ".git"), _sourceFolder, args);
}
