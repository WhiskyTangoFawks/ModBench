using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// Spriggit's own Fallout 4 <c>Customizations/Omit/</c> set, replicated (#455; ADR-0041's #444
/// amendment, "the source tree adopts Spriggit's layout wholesale"). Source:
/// <c>references/spriggit/Translation Packages/Spriggit.Json.Fallout4/Customizations/Omit/</c> —
/// grep-only clone, read at implementation. Three classes because <see cref="ICustomize{T}"/> is
/// per-record-type; that is Spriggit's own shape too, file for file.
///
/// <para><b>Adopted rather than allowlisted, and the distinction matters.</b> Unlike <c>SortList</c>,
/// plain <c>Omit</c> is available in this project's Serialization 1.37.1 pin, so the "closes at the
/// 1.38.x bump" rationale that justifies the other parity-allowlist rows does not apply here — a row
/// for these would be <i>permanent</i>, and a permanent row poisons the signal the allowlist exists to
/// carry, since an empty allowlist is #444's convergence trigger. Measured on the committed fixture
/// before adoption: these accounted for 982 of the 1,100 files that differed from real Spriggit's
/// tree, 89% of the total.</para>
///
/// <para><b>Why omitting is right on its own terms, not merely Spriggit-compatible.</b> All four
/// fields are bookkeeping or padding, and all four are actively harmful to a git-native working tree
/// (ADR-0041): <c>NumRecords</c> and <c>NextFormID</c> are derived counters recomputed on every write,
/// so keeping them means the root header diffs on every recompile regardless of what the user changed.
/// </para>
///
/// <para><b><c>Condition.Unknown1</c> was checked against xEdit, not just against Spriggit</b> — the
/// #459 precedent is that "this looks like noise" is exactly the reasoning that turns out to be
/// semantic data loss, and hundreds of distinct values is equally consistent with meaningful data
/// nobody has decoded. xEdit's FO4 definition of CTDA
/// (<c>references/TES5Edit/Core/wbDefinitionsFO4.pas</c>, <c>wbConditions</c>) declares the three bytes
/// immediately after the <c>Type</c> byte — exactly the bytes Mutagen surfaces as
/// <c>Condition.Unknown1</c>, confirmed by their 3-byte width — as <c>wbUnused(3)</c>. That is the
/// affirmative classification, not the agnostic one: xEdit distinguishes <c>wbUnused</c> from
/// <c>wbUnknown</c> (117 vs 28 uses in the FO4 definitions alone) and actively curates fields between
/// them in both directions as they are decoded (<c>whatsnew.md</c>: "[FO4/FO76] SPGD - Mark fields as
/// unused instead of unknown"; "WEAP - Decode the Embedded Weapon flag ... previously marked unused").
/// It gives the field no name, no editor and no warning, and <c>EditTips.txt</c> says nothing about
/// condition padding. The reference implementation of this domain concluded these bytes carry no
/// meaning; we follow it.</para>
///
/// <para><b>Reach.</b> Like <see cref="SpriggitCellEmbedCustomization"/>, these are generation-time
/// customizations read by the source generator, so they change <i>both</i> doors together — the
/// per-record codec and the whole-mod folder-split output. "One document shape everywhere" is
/// preserved by construction, and <c>DocumentShapeParityTests</c> checks it rather than assuming it.
/// They do not affect the binary read/write path at all, so <c>BinaryRoundTripGateTests</c> is
/// untouched, and <c>CompileRoundTripGateTests</c> measures source-text fidelity and compile
/// determinism rather than original-binary byte identity, so an omitted field is simply absent from
/// both sides of every comparison it makes.</para>
/// </summary>
public sealed class SpriggitConditionOmitCustomization : ICustomize<IConditionGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IConditionGetter> builder)
    {
        builder.Omit(x => x.Unknown1);
    }
}

/// <inheritdoc cref="SpriggitConditionOmitCustomization"/>
public sealed class SpriggitModHeaderOmitCustomization : ICustomize<IFallout4ModHeaderGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IFallout4ModHeaderGetter> builder)
    {
        builder.Omit(x => x.OverriddenForms);
    }
}

/// <inheritdoc cref="SpriggitConditionOmitCustomization"/>
public sealed class SpriggitModStatsOmitCustomization : ICustomize<IModStatsGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IModStatsGetter> builder)
    {
        builder.Omit(x => x.NextFormID);
        builder.Omit(x => x.NumRecords);
    }
}
