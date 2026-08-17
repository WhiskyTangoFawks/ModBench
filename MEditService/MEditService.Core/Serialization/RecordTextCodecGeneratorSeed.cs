using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Serialization.Yaml;

namespace MEditService.Core.Serialization;

/// <summary>
/// #367: exists only to give <c>Mutagen.Bethesda.Serialization.SourceGenerator</c> a concrete,
/// compile-time-typed call site to generate <c>&lt;Type&gt;_Serialization</c> classes from. Do not
/// delete this without reading the rest of this comment first.
///
/// The generator's seeding is syntax-driven (traced from its own <c>BootstrapInvocationDetector</c>):
/// it scans for a member-access invocation whose receiver implements
/// <c>IMutagenSerializationBootstrap</c> (that's <c>MutagenYamlConverter.Instance</c>) and inspects
/// argument 0's compile-time type. Whatever concrete type that is becomes the root of the object
/// graph the generator walks and emits <c>_Serialization</c> classes for.
///
/// Decompiling the generator's actual output settled three things empirically (#367 report has the
/// full investigation — do not re-derive by guessing, re-run the probe there if this ever needs
/// re-checking):
///
/// 1. <b>There is no per-record-only seed shape.</b> A <see cref="Mutagen.Bethesda.Plugins.Records.IGroupGetter{T}"/>
///    argument does not seed anything (only a stub <c>MutagenYamlConverterMixIns</c> constrained to
///    <c>IModGetter</c> is emitted); the friendly <c>MutagenYamlConverter.Instance.Serialize(item, folder)</c>
///    convenience overload is itself a per-seeded-type generated mixin, and it is only generated for
///    the mod-shaped type (it has ModKey/GameRelease/a "Data" meta file — a record does not), never
///    for an individual record. A record's own <c>&lt;Type&gt;_Serialization.Serialize</c> static
///    method is real and callable once generated (that's what <see cref="RecordTextCodec"/> calls
///    directly), but nothing about calling it seeds anything — it is a plain generated static method,
///    not itself <c>IMutagenSerializationBootstrap</c>-shaped. So a concrete mod-shaped argument has
///    to exist <b>somewhere</b> in this assembly for any record type (including
///    <see cref="Mutagen.Bethesda.Fallout4.Weapon"/>) to be generated at all — there is no way to
///    seed "just Weapon" from nothing.
///
/// 2. <b>Seeding with a mod-shaped type generates the entire ~586-type FO4 record schema</b>
///    (verified: identical file count to seeding with the whole mod directly), not just Weapon's own
///    subtree — one-time cost on a clean build (measured ~4.4 s added; ~0 on incremental rebuilds,
///    the generator's output is cached). That means every record type's <c>_Serialization</c> class
///    already exists in this assembly today, generalizing this codec to other record types is a
///    dispatch problem, not a generation problem — noted for whichever ticket does that, not
///    relevant to what this seed does.
///
/// 3. <b>Seeding with a mod-shaped type also generates a working, PUBLIC, whole-mod
///    <c>MutagenYamlConverterFallout4ModMixIns</c> class</b>, in the third-party namespace
///    <c>Mutagen.Bethesda.Serialization.Yaml</c>, with real <c>Serialize(IFallout4ModGetter, ...)</c>
///    and <c>DeserializeInto(...)</c> methods — a structurally unavoidable side effect of point 1,
///    confirmed to have no generator option that suppresses it while still producing the per-record
///    classes. <b>Nothing in this codebase may ever call it.</b> ADR-0040 rejected whole-mod text
///    export as the vendoring mechanism on measured grounds (spike #359, Q2): 21 s / 132,787 files /
///    106 MB for a 20 MB plugin, versus 160 ms for a single record. AC2 exists to keep that decision
///    real, not just documented — "no whole-mod serialization API is exposed to callers" is a
///    statement about this codebase's own designed surface (enforced by
///    <c>RecordTextCodecGeneratorSeedTests.SerializationNamespace_ExposesNoPublicApiAcceptingAWholeModType</c>),
///    not a claim that the generated mixin doesn't exist — it does, it is simply never on a path
///    anything reaches. The concrete temptation this is warning about: rebuilding a plugin from its
///    text ledger (crash repair, #381) is a real user path, and
///    <c>MutagenYamlConverterFallout4ModMixIns.DeserializeInto</c> will look like the obvious tool
///    for it. It is exactly the wrong one — it re-imports the equivalent of a whole-mod export, the
///    thing ADR-0040 measured and rejected. The right tool for that job is per-record deserialize
///    (<see cref="RecordTextCodec.DeserializeAsync"/>) applied one record at a time.
///
/// So this seed exists, and is deliberately unreachable: <see cref="Touch"/> only calls
/// <c>MutagenYamlConverter.Instance.Serialize</c> when handed a non-null mod, and no caller ever
/// passes one — <see cref="RecordTextCodec"/>'s static constructor calls it with the default (null),
/// which short-circuits before the call the generator is scanning for.
///
/// <b>If this class or its call from <see cref="RecordTextCodec"/>'s static constructor is deleted:</b>
/// the failure is a <i>compile</i> error, not a test failure, and it will look unrelated —
/// <see cref="RecordTextCodec"/>'s own calls to <c>Weapon_Serialization.Serialize</c>/
/// <c>.Deserialize</c> stop resolving (<c>CS0103</c>/similar), because that generated class stops
/// existing once nothing seeds it. There is no way to make <see cref="Touch"/> a genuinely dead,
/// never-called private method instead — this repo's analyzers (<c>SonarAnalyzer</c> <c>S1144</c>,
/// unused private member, confirmed to fire and fail the build under <c>TreatWarningsAsErrors</c>)
/// reject that shape outright, which is why it is a real, invoked, guarded no-op rather than an
/// unreferenced method with a comment asking people not to delete it.
/// </summary>
internal static class RecordTextCodecGeneratorSeed
{
    internal static Task Touch(IFallout4ModGetter? mod = null, string folder = "")
        => mod is null ? Task.CompletedTask : MutagenYamlConverter.Instance.Serialize(mod, folder);
}
