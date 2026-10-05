using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryRenameSourceTests : IDisposable
{
    private const string LastWritten = "OLD-BINARY";
    private static readonly PluginAddress Old = new("Old.esp", TestMod.Name);
    private static readonly PluginAddress Other = new("Other.esp", TestMod.Name);
    private readonly ScratchDirectory _modFolder = new("medit-rename-source-");

    private static readonly (string Path, string Text)[] OldTree =
    [
        ("RecordData.json", """
            {
              "ModKey": "Old.esp",
              "ModHeader": {
                "MasterReferences": [ { "Master": "Master.esm" } ]
              }
            }
            """),
        ("Npcs/SelfNpc - 000801_Old.esp.json", """
            {
              "FormKey": "000801:Old.esp",
              "EditorID": "SelfNpc",
              "Name": "Old.esp",
              "ShortName": "see 000802:Old.esp",
              "Race": "000802:Old.esp"
            }
            """),
        ("Npcs/MasterNpc - 000800_Master.esm.json", """
            {
              "FormKey": "000800:Master.esm",
              "Race": "000802:Old.esp"
            }
            """),
        ("Npcs/000803_My_Old.esp.json", """
            {
              "FormKey": "000803:My_Old.esp"
            }
            """),
        ("Cells/0/0/GroupRecordData.json", "{}"),
        ("Cells/0/0/EmbedCell - 000804_Old.esp/RecordData.json", """
            {
              "FormKey": "000804:Old.esp",
              "Temporary": [
                { "FormKey": "000805:Old.esp", "Base": "000800:Master.esm" }
              ]
            }
            """),
    ];

    public SourceRepositoryRenameSourceTests() =>
        SourceRepository.Track(
            _modFolder,
            [
                (Files(Old.Name, OldTree), new DecompiledPlugin(Old.Name, LastWritten)),
                (Files(Other.Name, [("RecordData.json", """{ "ModKey": "Other.esp" }""")]), new DecompiledPlugin(Other.Name, null)),
            ]);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void RenameSource_MovesTheTreeToTheNewName_AndEveryFormKeyOfThePluginFollowsIt_InTextAndInLeafNames()
    {
        Assert.True(Repository.RenameSource(Old, "New.esm"));

        Assert.False(Directory.Exists(PluginSourceRoot.In(_modFolder, Old.Name)));
        Assert.Equal(
            [
                ("Cells/0/0/EmbedCell - 000804_New.esm/RecordData.json", """
                    {
                      "FormKey": "000804:New.esm",
                      "Temporary": [
                        { "FormKey": "000805:New.esm", "Base": "000800:Master.esm" }
                      ]
                    }
                    """),
                ("Cells/0/0/GroupRecordData.json", "{}"),
                ("Npcs/000803_My_Old.esp.json", """
                    {
                      "FormKey": "000803:My_Old.esp"
                    }
                    """),
                ("Npcs/MasterNpc - 000800_Master.esm.json", """
                    {
                      "FormKey": "000800:Master.esm",
                      "Race": "000802:New.esm"
                    }
                    """),
                ("Npcs/SelfNpc - 000801_New.esm.json", """
                    {
                      "FormKey": "000801:New.esm",
                      "EditorID": "SelfNpc",
                      "Name": "Old.esp",
                      "ShortName": "see 000802:Old.esp",
                      "Race": "000802:New.esm"
                    }
                    """),
                ("RecordData.json", """
                    {
                      "ModKey": "New.esm",
                      "ModHeader": {
                        "MasterReferences": [ { "Master": "Master.esm" } ]
                      }
                    }
                    """),
            ],
            TreeOf("New.esm"));
    }

    [Fact]
    public void RenameSource_MovesWhatModbenchLastWroteToTheNewName()
    {
        Repository.RenameSource(Old, "New.esp");

        Assert.Equal([LastWritten], Repository.LastWrittenBinarySha256s(Old with { Name = "New.esp" }));
        Assert.Empty(Repository.LastWrittenBinarySha256s(Old));
    }

    [Fact]
    public void RenameSource_LeavesTheRenameAsWorkingTreeChanges_AndCommitsNothing()
    {
        var head = Git("rev-parse", "HEAD");

        Repository.RenameSource(Old, "New.esp");

        Assert.Equal(head, Git("rev-parse", "HEAD"));
        Assert.Contains("plugin-source/New.esp/", Git("status", "--porcelain", "--untracked-files=all"), StringComparison.Ordinal);
    }

    [Fact]
    public void RenameSource_KeepsADocumentsByteOrderMark()
    {
        var self = Path.Combine(PluginSourceRoot.In(_modFolder, Old.Name), "Npcs", "SelfNpc - 000801_Old.esp.json");
        File.WriteAllBytes(self, [0xEF, 0xBB, 0xBF, .. """{"FormKey":"000801:Old.esp"}"""u8]);

        Repository.RenameSource(Old, "New.esp");

        Assert.Equal(
            [0xEF, 0xBB, 0xBF, .. """{"FormKey":"000801:New.esp"}"""u8],
            File.ReadAllBytes(Path.Combine(PluginSourceRoot.In(_modFolder, "New.esp"), "Npcs", "SelfNpc - 000801_New.esp.json")));
    }

    [Theory]
    [InlineData("OTHER.esp")]
    [InlineData("OLD.ESP")]
    public void RenameSource_ToANameThatAPluginSourceHoldsComparedWithoutCase_WritesNothing(string taken)
    {
        var before = TreeOf(Old.Name);

        Assert.False(Repository.RenameSource(Old, taken));

        Assert.Equal(before, TreeOf(Old.Name));
        Assert.Equal(["Old.esp", "Other.esp"], PluginSources());
        Assert.Equal([LastWritten], Repository.LastWrittenBinarySha256s(Old));
    }

    [Fact]
    public void RenameSource_OfATreeHoldingADocumentThatIsNoJson_RefusesNamingIt_AndWritesNothing()
    {
        var broken = Path.Combine(PluginSourceRoot.In(_modFolder, Old.Name), "Npcs", "SelfNpc - 000801_Old.esp.json");
        File.WriteAllText(broken, """{ "FormKey": "000801:Old.esp", """);
        var before = TreeOf(Old.Name);

        var refused = Assert.Throws<UnreadableSourceDocumentException>(() => Repository.RenameSource(Old, "New.esp"));

        Assert.Contains("SelfNpc - 000801_Old.esp.json", refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, TreeOf(Old.Name));
        Assert.Equal(["Old.esp", "Other.esp"], PluginSources());
    }

    [Fact]
    public void RenameSource_WhenGitRefusesToMoveWhatModbenchLastWrote_PutsTheTreeAndTheRefBack()
    {
        var before = TreeOf(Old.Name);
        var lockOfTheNewRef = Path.Combine(_modFolder, ".git", "refs", "medit", "last-compile", "New.esp.lock");
        File.WriteAllText(lockOfTheNewRef, "");

        Assert.ThrowsAny<InvalidOperationException>(() => Repository.RenameSource(Old, "New.esp"));

        Assert.Equal(before, TreeOf(Old.Name));
        Assert.Equal(["Old.esp", "Other.esp"], PluginSources());
        Assert.Equal([LastWritten], Repository.LastWrittenBinarySha256s(Old));
    }

    [Fact]
    public void RenameSource_WhenTheOldTreeCannotAllBeDeleted_PutsBackWhatWent_TakesTheNewTreeAway_AndPutsTheRefBack()
    {
        var before = TreeOf(Old.Name);
        var npcs = Path.Combine(PluginSourceRoot.In(_modFolder, Old.Name), "Npcs");
        FileModes.Set(npcs, "555");
        try
        {
            Assert.ThrowsAny<UnauthorizedAccessException>(() => Repository.RenameSource(Old, "New.esp"));
        }
        finally
        {
            FileModes.Set(npcs, "755");
        }

        Assert.Equal(before, TreeOf(Old.Name));
        Assert.Equal(["Old.esp", "Other.esp"], PluginSources());
        Assert.Equal([LastWritten], Repository.LastWrittenBinarySha256s(Old));
        Assert.Empty(Repository.LastWrittenBinarySha256s(Old with { Name = "New.esp" }));
    }

    private SourceRepository Repository => SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4).Require();

    private static List<TreeFile> Files(string plugin, IEnumerable<(string Path, string Text)> tree) =>
        [.. tree.Select(file => new TreeFile($"plugin-source/{plugin}/{file.Path}", Encoding.UTF8.GetBytes(file.Text)))];

    private (string Path, string Text)[] TreeOf(string plugin)
    {
        var root = PluginSourceRoot.In(_modFolder, plugin);
        return [.. Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select(path => (Path.GetRelativePath(root, path).Replace('\\', '/'), File.ReadAllText(path)))
            .OrderBy(file => file.Item1, StringComparer.Ordinal)];
    }

    private string[] PluginSources() =>
        [.. Directory.EnumerateDirectories(Path.Combine(_modFolder, "plugin-source")).Select(Path.GetFileName).OfType<string>().Order(StringComparer.Ordinal)];

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
