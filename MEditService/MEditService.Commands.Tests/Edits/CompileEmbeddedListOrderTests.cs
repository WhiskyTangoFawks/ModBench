using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompileEmbeddedListOrderTests : TestInstance
{
    private const string CellEditorId = "Room";

    private readonly PluginAddress _plugin;
    private readonly FormKey _cell;

    public CompileEmbeddedListOrderTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("EmbeddedList.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = CellEditorId, Flags = Cell.Flag.IsInteriorCell };
        cell.Temporary.AddRange([Placed(mod, "Ref1"), Placed(mod, "Ref2"), Placed(mod, "Ref3")]);
        mod.Cells.Records.Add(new CellBlock { BlockNumber = 0, SubBlocks = [new CellSubBlock { BlockNumber = 0, Cells = [cell] }] });
        _cell = cell.FormKey;
        _plugin = Add(mod, "EmbeddedListMod");
    }

    private static PlacedObject Placed(Fallout4Mod mod, string editorId) => new(mod) { EditorID = editorId };

    [Fact]
    public async Task Compile_OfASourceWithTheMiddleElementRemoved_KeepsTheOthersInOrder()
    {
        var original = ReferencesIn(this.Binary(_plugin));

        var compiled = await ReferencesAfter(cell => cell.Temporary.RemoveAt(1));

        Assert.Equal([original[0], original[2]], compiled);
    }

    [Fact]
    public async Task Compile_OfASourceWithTheFirstAndLastElementsSwapped_SwapsTheChildren()
    {
        var original = ReferencesIn(this.Binary(_plugin));

        var compiled = await ReferencesAfter(cell => (cell.Temporary[0], cell.Temporary[2]) = (cell.Temporary[2], cell.Temporary[0]));

        Assert.Equal([original[2], original[1], original[0]], compiled);
    }

    private static IReadOnlyList<FormKey> ReferencesIn(IFallout4ModDisposableGetter binary)
    {
        using (binary) return [.. binary.Cells.Records.Single().SubBlocks.Single().Cells.Single().Temporary.Select(placed => placed.FormKey)];
    }

    private async Task<IReadOnlyList<FormKey>> ReferencesAfter(Action<Cell> editTheSource)
    {
        SourceEdits.Rewrite(
            RepositoryOf(_plugin).Require(), _plugin, new RecordIdentity(_cell.ToString(), "cell", CellEditorId), GameRelease.Fallout4, editTheSource);
        return ReferencesIn(await this.CompiledAsync(_plugin));
    }
}
