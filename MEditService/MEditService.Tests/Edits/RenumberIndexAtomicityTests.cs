using MEditService.Core.Records;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>A renumber's index update commits once or not at all. The fault is real, not
/// injected: a body the declared record type cannot parse throws after its own insert is written.
/// Reader isolation is not claimed.</summary>
public sealed class RenumberIndexAtomicityTests : IDisposable
{
    // Free at both refs in ContainerModFixture's plugin.
    private static readonly string NewFormKey =
        FormKey.Factory($"000F00:{ContainerModFixture.PluginName}").ToString();

    // Valid JSON, and nothing the codec can rebuild a record from.
    private const string UnparseableBody = """{ "not": "a record" }""";

    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private IRecordIndex Index => _fixture.Mirror.Index!;
    private IRecordReads Effective => Index.At(RecordRef.Effective);

    [Fact]
    public void AFaultInsideRenumbersCreateStep_LeavesNoRowForTheNewIdentity()
    {
        var quest = _fixture.Quest.ToString();
        var before = Snapshot(quest);

        Assert.ThrowsAny<Exception>(() => Index.ApplyRenumber(
            _fixture.Plugin,
            new RenumberedRecord(quest, NewFormKey, RecordTypeOf(quest), UnparseableBody)));

        Assert.Null(Effective.GetDocument(NewFormKey, _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Head).GetDocument(NewFormKey, _fixture.Plugin));
        Assert.Equal(before, Snapshot(quest));
    }

    private string RecordTypeOf(string formKey) =>
        Effective.GetDocument(formKey, _fixture.Plugin)!.RecordType;

    private string Snapshot(string formKey) =>
        $"{Effective.GetDocument(formKey, _fixture.Plugin)?.Body ?? "absent"}\n" +
        string.Join(",", Effective.GetContainerChildren(_fixture.Plugin, formKey)
            .Select(c => $"{c.SlotName}[{c.SlotIndex}]={c.ChildFormKey}")
            .OrderBy(s => s, StringComparer.Ordinal));
}
