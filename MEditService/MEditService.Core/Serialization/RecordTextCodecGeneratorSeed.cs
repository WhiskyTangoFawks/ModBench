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
/// graph the generator walks and emits <c>_Serialization</c> classes for. This runs at compile time,
/// during the generator pass — <see cref="Touch"/> below does not need to ever execute, let alone
/// execute with a real mod, for this to work.
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
///    seed "just Weapon" from nothing. Confirmed absolute, not conditional on <c>.FilePerRecord()</c>:
///    removing that customization does not free a smaller seed shape — a record-shaped seed without
///    it does not even compile (the generator takes a different, broken code path for a non-mod type
///    and emits code referencing undefined members), and a mod-shaped seed without it still generates
///    the same public mixin described in point 3. Filed as #387 for the generator's own maintainers.
///
/// 2. <b>Seeding with a mod-shaped type generates the entire ~586-type FO4 record schema</b>
///    (verified: identical file count to seeding with the whole mod directly), not just Weapon's own
///    subtree — one-time cost on a clean build (measured ~4.4 s added; ~0 on incremental rebuilds,
///    the generator's output is cached). That means every record type's <c>_Serialization</c> class
///    already exists in this assembly today, so generalizing this codec to other record types is
///    <b>not only</b> a dispatch problem (mapping a runtime-typed record to its already-generated
///    static method) — under <c>.FilePerRecord()</c>, <c>Cell</c>/<c>Worldspace</c>/<c>Quest</c>/
///    <c>DialogTopic</c> and other records with their own nested record-bearing collections serialize
///    as folder trees, not single files, which breaks the one-record-one-file contract this codec's
///    own layout test asserts. Whichever ticket generalizes this needs a per-type layout answer, not
///    just a dispatch table — noted here so it isn't scoped from a wrong assumption.
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
///    <c>RecordTextCodecGeneratorSeedTests</c>, including a source scan pinning that this mixin's
///    namespace appears nowhere in this project's own source outside this file), not a claim that the
///    generated mixin doesn't exist — it does, it is simply never on a path anything reaches. The
///    concrete temptation this is warning about: rebuilding a plugin from its text ledger (crash
///    repair, #381) is a real user path, and <c>MutagenYamlConverterFallout4ModMixIns.DeserializeInto</c>
///    will look like the obvious tool for it. It is exactly the wrong one — it re-imports the
///    equivalent of a whole-mod export, the thing ADR-0040 measured and rejected. The right tool for
///    that job is per-record deserialize (<see cref="RecordTextCodec.DeserializeAsync"/>) applied one
///    record at a time.
///
/// <see cref="Touch"/> is deliberately unreachable and, just as deliberately, uncalled: it only
/// invokes <c>MutagenYamlConverter.Instance.Serialize</c> when handed a non-null mod, and nothing in
/// this codebase ever calls <see cref="Touch"/> at all — seeding is syntax-driven (see above), so
/// nothing has to. <see cref="Touch"/> must stay <c>internal</c>, not <c>private</c>: this repo's
/// <c>SonarAnalyzer</c> rule <c>S1144</c> ("remove the unused private method") fires on unreferenced
/// <i>private</i> members but not <i>internal</i> ones (internal is a legitimate cross-assembly
/// surface via <c>InternalsVisibleTo(MEditService.Tests)</c>, so the analyzer doesn't treat an
/// unreferenced internal method the same way) — confirmed by deleting every call site and rebuilding:
/// 0 warnings, 0 errors, full suite green. Do not "clean up" this method by making it private or by
/// adding a call to it; either change is a regression even though both look like tidying.
///
/// <b>If this file is deleted:</b> the failure is a <i>compile</i> error in a different file, not a
/// test failure, and it will look unrelated — <see cref="RecordTextCodec"/>'s own calls to
/// <c>Weapon_Serialization.Serialize</c>/<c>.Deserialize</c> stop resolving
/// (<c>CS0103: The name 'Weapon_Serialization' does not exist in the current context</c>), because
/// that generated class stops existing once nothing in the assembly seeds it.
/// </summary>
internal static class RecordTextCodecGeneratorSeed
{
    internal static Task Touch(IFallout4ModGetter? mod = null, string folder = "")
        => mod is null ? Task.CompletedTask : MutagenYamlConverter.Instance.Serialize(mod, folder);
}
