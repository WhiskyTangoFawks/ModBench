using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class ManyRecordsMemoryTests : IDisposable
{
    private const string Master = "Master.esm";
    private const string Copies = "Copies.esp";
    private const string Script = "Ns:Attached";
    private const long MemoryLimit = 128_000_000;
    private const int Records = 400;
    private const int UnspillableNameLength = 100_000;
    private const int AnEighthOfMemoryNameLength = 8_000_000;

    private static readonly PluginAddress Mastered = new(Master, PluginOrigin.DataDirectory);
    private static readonly PluginAddress Copier = new(Copies, PluginOrigin.DataDirectory);

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("many-records-memory")
        .WithPlugin(Master).WithPlugin(Copies).Build();

    public void Dispose() => _fixture.Dispose();

    private static string FormKeyOf(int i) => $"{0x800 + i:X6}:{Master}";

    private static IEnumerable<PluginDocument> Items(IReadOnlyList<int> nameLengths, char letter) => nameLengths.Select((nameLength, i) =>
        new PluginDocument("misc", FormKeyOf(i), $$$"""
            {"FormKey": "{{{FormKeyOf(i)}}}", "EditorID": "Item{{{i}}}", "Name": "{{{new string(letter, nameLength)}}}",
             "VirtualMachineAdapter": {"Scripts": [{"Name": "{{{Script}}}"}]}}
            """));

    private OpenedIndex Reconciled(params int[] nameLengths) =>
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter(
            (Master, () => Items(nameLengths, 'x')),
            (Copies, () => Items(nameLengths, 'y'))), memoryLimit: MemoryLimit);

    public static TheoryData<int[]> NameLengths => new()
    {
        Enumerable.Repeat(UnspillableNameLength, Records).ToArray(),
        new[] { AnEighthOfMemoryNameLength, UnspillableNameLength, AnEighthOfMemoryNameLength },
    };

    [Theory]
    [MemberData(nameof(NameLengths))]
    public void RecordsWhoseCopiesNoSortHoldsAtOnce_AreEachAnsweredWhole(int[] nameLengths)
    {
        using var index = Reconciled(nameLengths);
        var formKeys = nameLengths.Select((_, i) => FormKeyOf(i)).ToList();

        var answer = index.Queries.GetCopyStates(formKeys, Copier).Value();

        Assert.Equal(formKeys, answer.Select(record => record.FormKey));
        Assert.All(answer, record => Assert.Equal(
            [(Mastered, ConflictThis.Master), (Copier, ConflictThis.Override)],
            record.Copies.Select(copy => (copy.Plugin, copy.ConflictThis))));
    }

    [Theory]
    [MemberData(nameof(NameLengths))]
    public void CopiesAttachingAScript_ThatNoSortHoldsAtOnce_AreEachAReference(int[] nameLengths)
    {
        using var index = Reconciled(nameLengths);
        var formKeys = nameLengths.Select((_, i) => FormKeyOf(i)).ToList();

        var answer = index.Queries.GetScriptReferences(Script).Value();

        Assert.Equal(
            [.. formKeys.Select(formKey => (formKey, Copier)), .. formKeys.Select(formKey => (formKey, Mastered))],
            answer.Copies.Select(copy => (copy.FormKey, copy.Plugin)));
        Assert.Empty(answer.Unread);
    }
}
