using System.Text;
using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceFolderLineEndingsTests : IDisposable
{
    private const string Crlf = "{\r\n  \"a\": 1\r\n}\r\n";
    private readonly ScratchDirectory _instance = new("medit-line-endings-");

    public void Dispose() => _instance.Dispose();

    [Theory]
    [InlineData(SourceModIn.NewRepository, "")]
    [InlineData(SourceModIn.InstanceRepository, "source/TestMod/")]
    public void UnderAUserConfigThatConvertsLineEndings_EachFileIsCommittedAsWritten_AndTheAttributesThatSayStayUntracked(SourceModIn heldIn, string inRepository)
    {
        var instanceGit = Path.Combine(_instance, ".git");
        GitProbe.Run(instanceGit, _instance, "init", "-q", "-b", "main");
        GitProbe.Run(instanceGit, _instance, "config", "user.name", "Test");
        GitProbe.Run(instanceGit, _instance, "config", "user.email", "test@localhost");
        var sourceFolder = Path.Combine(_instance, "source", TestMod.Name);
        TreeFile[] tree = [new("npc_/A.esp/000001.json", Encoding.UTF8.GetBytes(Crlf))];

        UserGitConfig.With("core.autocrlf", "true", () => Assert.Null(TestAdapters.Source().Init(
            sourceFolder, SourceInits.BuildFile, [(tree, PluginBaselines.Decompiled("A.esp"))],
            [new FileToCopy("readme.txt", () => new MemoryStream(Encoding.UTF8.GetBytes(Crlf)))], commit: true, heldIn: heldIn)));

        var (gitDir, workTree) = heldIn == SourceModIn.NewRepository ? (Path.Combine(sourceFolder, ".git"), sourceFolder) : (instanceGit, _instance);
        string Committed(string path) => GitProbe.Run(gitDir, workTree, "cat-file", "-p", $"HEAD:{inRepository}{path}");
        Assert.Equal([Crlf, Crlf], [Committed("plugin-source/A.esp/npc_/A.esp/000001.json"), Committed("readme.txt")]);
        Assert.True(File.Exists(Path.Combine(sourceFolder, ".gitattributes")));
        Assert.DoesNotContain($"{inRepository}.gitattributes", GitProbe.Run(gitDir, workTree, "ls-files").Split('\n'));
    }
}
