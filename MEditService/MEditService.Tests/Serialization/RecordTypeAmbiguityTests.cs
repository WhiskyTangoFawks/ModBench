using System.Reflection;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Serialization;

/// <summary>
/// <see cref="RecordTypeDispatch"/> derives "which documents must name their own type" from
/// the game's own group structure rather than from a table anyone maintains. Derived is only better
/// than tabulated if the derivation is swept — a rule read off reflection can be quietly wrong for a
/// whole class of types and still look right for the two anyone tried by hand.
/// </summary>
public sealed class RecordTypeAmbiguityTests
{
    private static readonly RecordTypeDispatch Dispatch = RecordTypeDispatch.For(GameRelease.Fallout4);

    /// <summary>Every concrete major record type in the game's own schema is reachable by the
    /// lowercased CLR name <c>SourceRecordType.Resolve</c> falls back to — the spelling Track writes
    /// into a source path for anything <c>SchemaReflector</c> excludes (land/navm/navi and the
    /// REFR-flavour placements).</summary>
    [Fact]
    public void ConcreteFor_ResolvesEveryConcreteMajorRecordTypeByItsClrName()
    {
        var unresolved = ConcreteMajorRecordTypes()
            .Where(t => Dispatch.ConcreteFor(t.Name) != t)
            .Select(t => t.Name)
            .ToList();

        Assert.NotEmpty(ConcreteMajorRecordTypes());
        Assert.Empty(unresolved);
    }

    /// <summary>
    /// And by the other spelling the same column carries: the schema table name ingest stores. A
    /// table name that resolved to nothing would send every document of that type down the
    /// self-describing path, where an undiscriminated document fails outright — so this is the check
    /// that keeps reconstitution working for the ~180 types nobody writes a test for.
    /// </summary>
    [Fact]
    public void ConcreteFor_ResolvesEverySchemaTableName()
    {
        // "header" is the one table with no document to reconstitute — a ModHeader is not an
        // IMajorRecordGetter, so it never reaches this codec at all and RecordDocument.Body is null
        // for it (MEditService/CLAUDE.md). Excluded by name rather than by predicate, so a
        // second unresolvable table name cannot hide behind a rule that quietly grew to cover it.
        var tableNames = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Keys
            .Where(n => n != "header")
            .ToList();

        var unresolved = tableNames.Where(n => Dispatch.ConcreteFor(n) is null).ToList();

        Assert.NotEmpty(tableNames);
        Assert.Empty(unresolved);
    }

    /// <summary>
    /// The rule itself, stated in both directions on types whose whole-mod behaviour was
    /// measured: GLOB and GMST split into several concrete subclasses under an abstract group element
    /// and keep their discriminators; WEAP/NPC_ have concrete group elements; CELL has no
    /// <c>Group&lt;Cell&gt;</c> at all and neither do the child records — all four of those write no
    /// discriminator on either door.
    /// </summary>
    [Theory]
    [InlineData("glob", true)]
    [InlineData("globalfloat", true)]
    [InlineData("gmst", true)]
    [InlineData("weap", false)]
    [InlineData("npc_", false)]
    [InlineData("cell", false)]
    [InlineData("wrld", false)]
    [InlineData("refr", false)]
    [InlineData("landscape", false)]
    public void IsPathAmbiguous_MatchesTheWholeModDoorsOwnPolicy(string recordType, bool expected) =>
        Assert.Equal(expected, Dispatch.IsPathAmbiguous(recordType));

    /// <summary>
    /// Ingest hands the serializer binary-overlay getters, whose runtime type is
    /// <c>&lt;Concrete&gt;BinaryOverlay</c> and which do <b>not</b> derive from the concrete setter
    /// class. A rule that tested assignability against the abstract group element directly would
    /// therefore answer "unambiguous" for every record a real load order indexes, and every GLOB in the
    /// index would come back as the schema's discovery winner. Pinned against the real type name
    /// rather than a hand-written string.
    /// </summary>
    [Fact]
    public void IsPathAmbiguous_ForAnOverlayReadersOwnRuntimeType_AnswersAsForTheConcreteType()
    {
        var overlay = typeof(Fallout4Mod).Assembly.GetType("Mutagen.Bethesda.Fallout4.GlobalFloatBinaryOverlay", throwOnError: true)!;

        Assert.True(Dispatch.IsPathAmbiguous(overlay));
        Assert.False(Dispatch.IsPathAmbiguous(
            typeof(Fallout4Mod).Assembly.GetType("Mutagen.Bethesda.Fallout4.WeaponBinaryOverlay", throwOnError: true)!));
    }

    /// <summary>
    /// A second, independent derivation of the same fact, so the group-structure rule is checked
    /// against something other than itself: a GRUP signature carried by more than one concrete
    /// record type is exactly a signature whose group element had to be abstract to hold them. If
    /// these two ever disagree, one of them has stopped describing this game's schema and the
    /// discriminator policy is guessing.
    /// </summary>
    [Fact]
    public void TheAbstractGroupElementRule_AgreesWithSignaturesThatSeveralConcreteTypesShare()
    {
        var bySignature = ConcreteMajorRecordTypes()
            .GroupBy(SignatureOf, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var shared = bySignature.Where(g => g.Count() > 1).Select(g => g.Key).OrderBy(k => k, StringComparer.Ordinal);
        var ambiguous = bySignature
            .Where(g => g.Any(t => Dispatch.IsPathAmbiguous(t)))
            .Select(g => g.Key)
            .OrderBy(k => k, StringComparer.Ordinal);

        Assert.NotEmpty(shared);
        Assert.Equal(shared, ambiguous);
    }

    private static List<Type> ConcreteMajorRecordTypes() =>
        [.. typeof(Fallout4Mod).Assembly.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface)
            .Where(t => typeof(IMajorRecordGetter).IsAssignableFrom(t))
            .Where(t => t.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static) is not null)];

    private static string SignatureOf(Type type) =>
        ((RecordType)type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!).Type;
}
