using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>ADR-0046: the projection sequence advances exactly once per row-changing write,
/// whichever collaborator did the writing, and never for a call that changed nothing.</summary>
public sealed class ProjectionSequenceTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);
    private static readonly PluginKey BaseKey = new("Base.esm", "Data");

    private readonly PluginFixtureData _fixture;
    private readonly FormKey _npc1;
    private readonly FormKey _npc2;

    public ProjectionSequenceTests()
    {
        FormKey fk1 = default, fk2 = default;
        _fixture = new PluginFixtureBuilder("projection-sequence")
            .WithPlugin("Base.esm", mod =>
            {
                fk1 = mod.Npcs.AddNew("First").FormKey;
                fk2 = mod.Npcs.AddNew("Second").FormKey;
            })
            .Build();
        _npc1 = fk1;
        _npc2 = fk2;
    }

    public void Dispose() => _fixture.Dispose();

    private static DuckDbRecordIndex OpenIndex()
    {
        var index = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);
        return index;
    }

    private IModGetter LoadBaseMod() =>
        Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Base.esm"), Path.Combine(_fixture.DataFolder, "Base.esm")),
            Fallout4Release.Fallout4);

    [Fact]
    public void FreshIndex_SequenceIsZero()
    {
        using var index = OpenIndex();
        Assert.Equal(0, index.Sequence);
    }

    [Fact]
    public void Index_Ingest_AdvancesTheSequence()
    {
        using var index = OpenIndex();
        var before = index.Sequence;

        index.Index(LoadBaseMod(), Registration.Participating(0), BaseKey);

        Assert.True(index.Sequence > before);
    }

    [Fact]
    public void Unindex_AdvancesTheSequence()
    {
        using var index = OpenIndex();
        index.Index(LoadBaseMod(), Registration.Participating(0), BaseKey);
        var before = index.Sequence;

        index.Unindex(BaseKey);

        Assert.True(index.Sequence > before);
    }

    [Fact]
    public void Register_AdvancesTheSequence()
    {
        using var index = OpenIndex();
        index.Index(LoadBaseMod(), Registration.Participating(0), BaseKey);
        var before = index.Sequence;

        index.Register(BaseKey, Registration.Participating(1));

        Assert.True(index.Sequence > before);
    }

    [Fact]
    public void Unregister_AdvancesTheSequence()
    {
        using var index = OpenIndex();
        index.Index(LoadBaseMod(), Registration.Participating(0), BaseKey);
        var before = index.Sequence;

        index.Unregister(BaseKey);

        Assert.True(index.Sequence > before);
    }

    [Fact]
    public void UpdateWinners_AdvancesTheSequence()
    {
        using var index = OpenIndex();
        index.Index(LoadBaseMod(), Registration.Participating(0), BaseKey);
        var before = index.Sequence;

        index.UpdateWinners();

        Assert.True(index.Sequence > before);
    }

    [Fact]
    public void ProjectDocuments_TwoDeltasInOneCall_AdvancesTheSequenceOnce()
    {
        using var index = OpenIndex();
        index.Index(LoadBaseMod(), Registration.Participating(0), BaseKey);
        index.UpdateWinners();

        var formKey1 = _npc1.ToString();
        var formKey2 = _npc2.ToString();
        var body1 = index.At(RecordRef.Effective).GetDocument(formKey1, BaseKey)!.Body!
            .Replace("First", "FirstEdited", StringComparison.Ordinal);
        var body2 = index.At(RecordRef.Effective).GetDocument(formKey2, BaseKey)!.Body!
            .Replace("Second", "SecondEdited", StringComparison.Ordinal);

        var before = index.Sequence;
        index.ProjectDocuments(BaseKey, [(formKey1, body1), (formKey2, body2)]);

        Assert.Equal(before + 1, index.Sequence);
    }

    [Fact]
    public void ProjectDocuments_WithNoDeltas_DoesNotAdvanceTheSequence()
    {
        using var index = OpenIndex();
        index.Index(LoadBaseMod(), Registration.Participating(0), BaseKey);
        index.UpdateWinners();
        var before = index.Sequence;

        index.ProjectDocuments(BaseKey, []);

        Assert.Equal(before, index.Sequence);
    }
}
