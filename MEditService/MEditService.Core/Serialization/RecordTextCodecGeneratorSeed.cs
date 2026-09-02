using System.IO.Abstractions;
using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Serialization.Newtonsoft;
using Noggog.IO;

namespace MEditService.Core.Serialization;

/// <summary>
/// Exists only to give <c>Mutagen.Bethesda.Serialization.SourceGenerator</c> a concrete,
/// compile-time-typed call site to generate <c>&lt;Type&gt;_Serialization</c> classes from. Do not
/// delete this without reading the rest of this comment first.
///
/// The generator's seeding is syntax-driven (traced from its own <c>BootstrapInvocationDetector</c>):
/// it scans for a member-access invocation whose receiver implements
/// <c>IMutagenSerializationBootstrap</c> (that's <c>MutagenJsonConverter.Instance</c>) and inspects
/// argument 0's compile-time type. Whatever concrete type that is becomes the root of the object
/// graph the generator walks and emits <c>_Serialization</c> classes for. This runs at compile time,
/// during the generator pass — <see cref="Touch"/> below does not need to ever execute, let alone
/// execute with a real mod, for this to work.
///
/// Decompiling the generator's actual output settled three things empirically — do not re-derive
/// by guessing; re-run the probe if this ever needs re-checking:
///
/// 1. <b>There is no per-record-only seed shape.</b> A <see cref="Mutagen.Bethesda.Plugins.Records.IGroupGetter{T}"/>
///    argument does not seed anything (only a stub <c>MutagenJsonConverterMixIns</c> constrained to
///    <c>IModGetter</c> is emitted, by naming-convention analogy with point 3 below — not independently
///    re-verified for the JSON bootstrap, since nothing seeds this way); the friendly
///    <c>MutagenJsonConverter.Instance.Serialize(item, folder)</c>
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
///    the same public mixin described in point 3. Filed for the generator's own maintainers.
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
///    <c>MutagenJsonConverterFallout4ModMixIns</c> class</b>, in the third-party namespace
///    <c>Mutagen.Bethesda.Serialization.Newtonsoft</c> (re-verified against this project's own
///    kernel, version 1.37.1 — confirmed by seeding a scratch project with
///    <c>MutagenJsonConverter.Instance.Serialize</c> and inspecting the actual generated source via
///    <c>-p:EmitCompilerGeneratedFiles=true</c>, not assumed by naming-convention analogy alone), with real
///    <c>Serialize(IFallout4ModGetter, ...)</c>
///    and <c>DeserializeInto(...)</c> methods — a structurally unavoidable side effect of point 1,
///    confirmed to have no generator option that suppresses it while still producing the per-record
///    classes.
///
///    <b>Whole-mod-caller rule (ADR-0041 amendment, point 4): "no caller, ever" is scoped to "only
///    the designated doors, always with a sequential dropoff."</b> The earlier git-native design
///    (ADR-0041 § Alternatives rejected)
///    rejected whole-mod text export as the vendoring mechanism on measured grounds: 21 s / 132,787 files / 106 MB
///    for a 20 MB plugin, versus 160 ms for a single record, driven by its lazy per-edit,
///    redistribution-on-touch design. That design is superseded — Track (<see cref="Source.TrackService"/>)
///    is eager and one-time, ingest-from-source and compile are the same order of cost — so the
///    original rationale for a blanket ban no longer holds, and the ban re-scopes to a whitelist of
///    the doors that pay that cost deliberately, once, in their own designated place: Track,
///    ingest-from-source, compile. <c>RecordTextCodecGeneratorSeedTests</c>' source scan
///    enforces the whitelist (which files may name the mixin), not a blanket absence, and its own
///    companion test still enforces that <b>no public API in this namespace</b>
///    (<see cref="RecordTextCodec"/>'s own) ever accepts a whole-mod type — the per-record codec stays
///    per-record. The concrete temptation the original ban was warning about stands for every file
///    <i>not</i> on the whitelist: rebuilding a plugin from its text source outside a designated door
///    is exactly the wrong tool, still — the right one there remains per-record deserialize
///    (<see cref="RecordTextCodec.DeserializeAsync"/>) applied one record at a time.
///
/// <see cref="SerializeWholeMod"/> is the seed: a real method, really called by
/// <see cref="Source.TrackService"/>, rather than a deliberately-unreachable one. That shape is
/// forced, not stylistic — <b>the generator's bootstrap detector fires on syntax, not on runtime
/// reachability, and it fires once per <c>MutagenJsonConverter.Instance.X(mod, ...)</c> call site it
/// finds</b>. Two independent bootstrap-shaped call sites for the
/// identical <c>IFallout4ModGetter</c> seed type do not compile: the generator names the
/// generated mixin file after the seeded type, not the call site, so a second seed of the same type
/// collides on that name (<c>CS8785: "the hintName 'MutagenJsonConverter_Fallout4Mod_MixIns.g.cs' ...
/// must be unique within a generator"</c> — reproduced, not a hypothetical).
/// So exactly <b>one</b> textual <c>MutagenJsonConverter.Instance.X(...)</c> call
/// site may exist in this assembly, ever, here — every real caller goes through this method, never
/// through the mixin directly. <see cref="RecordTextCodecGeneratorSeedTests"/>' whitelist scan
/// enforces that the mixin's own generated type name never appears outside this file; the deeper
/// constraint this paragraph adds — one bootstrap call site total — has no test of its own beyond "the
/// build fails" if it is ever violated.
///
/// <b>If this file is deleted:</b> the failure is a <i>compile</i> error in a different file, not a
/// test failure, and it will look unrelated — <see cref="RecordTextCodec"/>'s own calls to
/// <c>Weapon_Serialization.Serialize</c>/<c>.Deserialize</c> stop resolving
/// (<c>CS0103: The name 'Weapon_Serialization' does not exist in the current context</c>), because
/// that generated class stops existing once nothing in the assembly seeds it.
/// </summary>
internal static class RecordTextCodecGeneratorSeed
{
    /// <summary>The one seed/gateway: every real whole-mod-door caller (Track, ingest-from-source,
    /// compile) calls this, never <c>MutagenJsonConverter.Instance</c>
    /// directly — see the class doc comment for why a second direct call site does not compile.
    ///
    /// <para><b>No <c>extraMeta</c> parameter, deliberately — a real generator defect,
    /// not a design choice.</b> The generated mixin always emits an
    /// <c>extraMeta = null</c> convenience overload; the moment any call site anywhere in the assembly
    /// passes a non-null <c>extraMeta</c> value, it <i>also</i> emits a second, <c>extraMeta</c>-required
    /// overload — and because both erase to a bare <c>object</c> parameter (nullability annotations
    /// aren't part of a CLR signature), the two collide: <c>CS0111: Type
    /// 'MutagenJsonConverterFallout4ModMixIns' already defines a member called 'Serialize'/'Deserialize'
    /// with the same parameter types</c>, reproduced on this project's 1.37.1 pin by trying exactly
    /// that. Nothing in this codebase needs <c>extraMeta</c> today (ADR-0042's amendment
    /// retired the format-identity stamp the original decision 5 would have needed this for — nothing
    /// is written to the root document to compare, merged side-object or otherwise), so the defect is
    /// currently moot rather than worked around — recorded here in case a future caller reaches for
    /// <c>extraMeta</c> and hits it fresh. Revisit if the Serialization pin ever bumps past 1.37.1 and
    /// this is confirmed fixed upstream.</para>
    ///
    /// <para><b><c>extraMeta: null</c> is passed explicitly, and removing it breaks the build in a way
    /// that names an unrelated type.</b> A second, nastier face of the same defect: the generator's
    /// <c>BootstrapInvocationDetector</c> resolves <c>extraMeta</c> as "the argument named
    /// <c>extraMeta</c>, or failing that <b>whatever sits at positional index 5</b>" — see
    /// <c>ArgumentRetriever.Get</c>, which falls back to the index without checking whether that
    /// argument is a <c>NameColon</c> for some other parameter entirely. This call has six arguments,
    /// so index 5 is <c>cancel:</c>, and without the explicit name the generator concluded the meta
    /// type was <see cref="CancellationToken"/> and emitted a <c>CancellationToken_Serializations</c>
    /// class — which then failed the build with two <c>CS0162: Unreachable code detected</c> errors
    /// inside generated code, naming a file no source in this repo mentions. Reproduced, then fixed by
    /// naming the argument; reordering does not help (whatever lands on index 5 gets picked instead,
    /// e.g. <c>ICreateStream</c>). Keep the name.</para>
    /// </summary>
    /// <param name="fileSystem">The filesystem the door writes through, or <see langword="null"/> for
    /// the real one. Named here rather than left to the mixin's own default so a caller that must not
    /// touch the disk can say so — <c>HeaderDocument.Write</c> pairs a non-creating filesystem with a
    /// <paramref name="streamCreator"/> that captures the root document in memory.</param>
    /// <param name="streamCreator">Where each file's bytes actually go, or <see langword="null"/> for
    /// real files. Under <c>.FilePerRecord()</c> the mixin takes the <i>root</i>
    /// <c>RecordData.json</c>'s own stream from here too (traced in <c>MixinGenerator</c>'s
    /// <c>SerializeInternal</c>: <c>exceptionPath = Path.Combine(path, RecordDataFileName)</c>, then
    /// <c>streamCreator.GetStreamFor(fileSystem, exceptionPath, write: true)</c>) — which is what lets
    /// a caller capture the mod header's own document without writing a tree.</param>
    internal static Task SerializeWholeMod(
        IFallout4ModGetter mod, string folder, Noggog.WorkEngine.IWorkDropoff workDropoff, CancellationToken cancel,
        IFileSystem? fileSystem = null, ICreateStream? streamCreator = null)
        => MutagenJsonConverter.Instance.Serialize(
            mod, folder, extraMeta: null, workDropoff: workDropoff,
            fileSystem: fileSystem, streamCreator: streamCreator, cancel: cancel);

    /// <summary>
    /// The read side of the same door (ingest-from-source): a whole <c>source/&lt;plugin&gt;/</c>
    /// tree back into a mod. Same rule as <see cref="SerializeWholeMod"/> — every real caller comes
    /// through here, never through <c>MutagenJsonConverter.Instance</c> directly.
    ///
    /// <para><b>This second call site does not re-trigger CS8785, and the reason is structural rather
    /// than lucky.</b> The generator's <c>BootstrapInvocationDetector</c> inspects <i>argument 0</i> and
    /// records an <c>ObjectRegistration</c> only when that argument's type is Loqui-shaped; here
    /// argument 0 is the folder, so the invocation is detected with a <see langword="null"/>
    /// <c>ObjectRegistration</c>. <c>MixinGenerator.Generate</c> opens with
    /// <c>if (bootstrap.ObjectRegistration == null) return;</c>, so this emits no mixin at all and
    /// therefore cannot collide on <c>MutagenJsonConverter_Fallout4Mod_MixIns.g.cs</c>'s hint name the
    /// way a second <i>mod-typed</i> call site did. Nor does it emit the fallback stub:
    /// <c>StubGenerator</c> fires only for a bootstrap whose invocations are
    /// <c>All(x =&gt; x.ObjectRegistration == null)</c>, and <see cref="SerializeWholeMod"/>'s is not.
    /// Traced in the generator's own source under <c>references/mutagen-serialization</c> —
    /// not inferred after the fact from the build happening to succeed.</para>
    ///
    /// <para>Sequential dropoff for the same reason the write side names one (a real upstream race
    /// in the parallel helpers), stated explicitly so a swap is a visible diff
    /// that <see cref="RecordTextCodecGeneratorSeedTests"/>' own guard can catch.</para>
    /// </summary>
    /// <param name="folder">The tree root to read.</param>
    /// <param name="workDropoff">Sequential, for the reason above.</param>
    /// <param name="cancel">Cancellation token.</param>
    /// <param name="fileSystem">The filesystem the door reads through, or <see langword="null"/> for
    /// the real one — the symmetric inverse of <see cref="SerializeWholeMod"/>'s own parameter.
    /// <b>Supplying <paramref name="streamCreator"/> alone is not enough to read from memory</b>:
    /// <c>SerializationHelper.ExtractMetaInternal</c> guards on
    /// <c>fileSystem.File.Exists(path)</c> before it ever consults the stream creator, and throws
    /// <c>FileNotFoundException("Could not find file to parse")</c> if that answers false (verified by
    /// trying exactly that). So an in-memory read needs both.</param>
    /// <param name="streamCreator">Where each file's bytes come from, or <see langword="null"/> for
    /// real files.</param>
    internal static async Task<IFallout4Mod> DeserializeWholeMod(
        string folder, Noggog.WorkEngine.IWorkDropoff workDropoff, CancellationToken cancel,
        IFileSystem? fileSystem = null, ICreateStream? streamCreator = null)
    {
        var mod = await MutagenJsonConverter.Instance.Deserialize(
            folder, workDropoff: workDropoff, fileSystem: fileSystem, streamCreator: streamCreator, cancel: cancel);

        // Order is parent data (ADR-0042 decision 4). Identity-only child names leave the reader's own
        // directory enumeration order undefined, so the mod is in no meaningful order at all until
        // each collection is restored from the ordered child list its parent's document carries.
        // Applied at the door itself, so no reader can obtain an unordered mod by forgetting to ask.
        SourceChildOrder.ApplyTo(folder, mod, fileSystem);
        return mod;
    }
}
