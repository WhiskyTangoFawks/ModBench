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

    [Theory]
    [InlineData("{\"output\": \"Mod\"}", new[] { "textures/b.dds", "meshes" }, new string[0],
        "{\n  \"output\": \"Mod\",\n  \"exclude\": [\n    \"meshes\",\n    \"textures/b.dds\"\n  ]\n}\n")]
    [InlineData("{\"output\": \"Mod\", \"exclude\": [\"textures/b.dds\"]}", new[] { "Textures/B.dds", "a.esp" }, new string[0],
        "{\n  \"output\": \"Mod\",\n  \"exclude\": [\n    \"a.esp\",\n    \"textures/b.dds\"\n  ]\n}\n")]
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

    [Theory]
    [InlineData(null)]
    [InlineData("{\"output\": ")]
    [InlineData("[\"output\"]")]
    [InlineData("{\"output\": \"Mod\", \"exclude\": [1]}")]
    public void AConfigurationThatIsNotThereOrNotReadable_RefusesAsUnreadable_AndIsLeftAsItWas(string? before)
    {
        if (before is not null) WriteBuildJson(before);

        var failure = TestAdapters.Source().ChangeBuildConfiguration(_sourceFolder, new BuildConfigurationChange("Other", [], []));

        var unreadable = Assert.IsType<SourceFailure.Unreadable>(failure);
        Assert.Contains(_sourceFolder, unreadable.Reason, StringComparison.Ordinal);
        Assert.Equal(before, File.Exists(BuildJsonPath) ? BuildJson() : null);
    }

    private string BuildJsonPath => Path.Combine(_sourceFolder, "build.json");

    private string BuildJson() => File.ReadAllText(BuildJsonPath, Encoding.UTF8);

    private void WriteBuildJson(string text) => File.WriteAllText(BuildJsonPath, text);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_sourceFolder, ".git"), _sourceFolder, args);
}
