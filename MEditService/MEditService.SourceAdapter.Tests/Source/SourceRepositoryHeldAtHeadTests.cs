using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Which records HEAD holds, asked of HEAD's text: a document's own, or a child another
/// document embeds, never a record another document only refers to.</summary>
public sealed class SourceRepositoryHeldAtHeadTests : IDisposable
{
    private const string PluginName = "Held.esp";
    private const string NpcFormKey = "000900:Held.esp";
    private const string ReferencedFormKey = "000B00:Held.esp";

    private static readonly PluginAddress Plugin = new(PluginName, "HeldMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private static readonly string NpcRelativePath =
        Path.Combine("plugin-source", PluginName, "Npcs", $"FixtureNpc - 000900_{PluginName}.json");

    private readonly ScratchDirectory _modFolder = new("medit-held-at-head-");
    private readonly string _childFormKey;
    private readonly SourceRepository _repository;

    public SourceRepositoryHeldAtHeadTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var child = new PlacedObject(mod) { EditorID = "TopCellRef", Position = new P3Float(7f, 8f, 9f) };
        var topCell = new Cell(mod) { EditorID = "TopCell" };
        topCell.Temporary.Add(child);
        var worldspace = new Worldspace(mod) { EditorID = "World", TopCell = topCell };
        _childFormKey = child.FormKey.ToString();
        var worldspacePath = Path.Combine(
            SourceRepository.RootFor(PluginName), "Worldspaces",
            $"{worldspace.EditorID} - {worldspace.FormKey.ID:X6}_{PluginName}", "RecordData.json");

        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits,
            [new TreeFile(SourceRepository.HeaderDocumentFor(PluginName), "{\"MasterReferences\": []}"u8.ToArray()),
             new TreeFile(NpcRelativePath, Encoding.UTF8.GetBytes(
                 $"{{\"FormKey\": \"{NpcFormKey}\", \"EditorID\": \"FixtureNpc\", \"Race\": \"{ReferencedFormKey}\"}}")),
             new TreeFile(worldspacePath, new RecordTextCodec(NullLogger<RecordTextCodec>.Instance).SerializeToBytes(worldspace, Release))]);
        _repository = SourceRepository.Over(_modFolder, Release);
    }

    public void Dispose() => _modFolder.Dispose();

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private static readonly string HeaderFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

    [Fact]
    public void ADocumentAnEmbeddedChildAndTheHeader_AreHeld_AndAReferencedRecordIsNot()
    {
        var held = _repository.HeldAtHead(Plugin, [NpcFormKey, _childFormKey, HeaderFormKey, ReferencedFormKey]).Require();

        Assert.Equal(
            new[] { NpcFormKey, _childFormKey, HeaderFormKey }.Order(StringComparer.Ordinal),
            held.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void RecordsACommitTookOut_AreNotHeld()
    {
        Git("rm", "-q", "--", NpcRelativePath.Replace('\\', '/'), SourceRepository.HeaderDocumentFor(PluginName).Replace('\\', '/'));
        Git("commit", "-q", "-m", "deletions committed outside Modbench");

        Assert.Empty(_repository.HeldAtHead(Plugin, [NpcFormKey, HeaderFormKey]).Require());
    }

    // JSON reads an escaped character as the character, so no text search for the FormKey finds the
    // document that declares it this way.
    [Fact]
    public void ADocumentDeclaringItsFormKeyThroughAJsonEscape_IsHeld()
    {
        const string escaped = "000A00:Held.esp";
        var relativePath = Path.Combine("plugin-source", PluginName, "Npcs", $"EscapedNpc - 000A00_{PluginName}.json");
        File.WriteAllText(
            Path.Combine(_modFolder, relativePath),
            """{"FormKey": "000A00\u003AHeld.esp", "EditorID": "EscapedNpc"}""");
        Git("add", "--", relativePath.Replace('\\', '/'));
        Git("commit", "-q", "-m", "a document another tool wrote with an escape");

        Assert.Equal([escaped], _repository.HeldAtHead(Plugin, [escaped]).Require());
    }
}
