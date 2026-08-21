using System.Diagnostics;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

/// <summary>
/// Runs the <b>real Spriggit translation package</b> as an out-of-process oracle — #455's
/// compatibility reference for "Spriggit is the format specification, never a code dependency"
/// (ADR-0041's #444 amendment, point 3).
///
/// <para><b>Why a subprocess, and why that is the only option that works.</b> The published
/// <c>Spriggit.Json.Fallout4</c> is a <c>PackAsTool</c> package: its <c>tools/&lt;tfm&gt;/any/</c>
/// folder carries its own <c>Mutagen.Bethesda.*</c> and <c>Mutagen.Bethesda.Serialization.*</c>
/// assemblies and its own <c>.deps.json</c>. Installed with <c>dotnet tool install --tool-path</c> and
/// invoked as a process, it shares no assembly load context with this test host, so
/// <b>nothing it pins can reach MEditService's dependency graph</b> — the 0.53.1 Mutagen pin (#385)
/// is safe by construction here, not by care. The alternatives are all closed: a
/// <c>ProjectReference</c> cannot be built (the package targets <c>net10.0</c>; this repo is .NET 9),
/// a <c>PackageReference</c> is not offered at all (tool packages are not library packages), and
/// in-process injection of their <c>IEntryPoint</c> — which ADR-0041's amendment prose assumes, and
/// which this class's existence is the erratum to — would drag Mutagen 0.54 straight into this
/// assembly.</para>
///
/// <para><b>The version is pinned, and to a specific one for two independent reasons.</b>
/// <see cref="MEditService.Core.Source.SpriggitSource.CurrentVersion"/> is the pin, and that constant's
/// own comment carries the rule that it must equal whatever the gate runs against. 0.40.1 is the
/// newest release shipping a <c>tools/net9.0</c> build (0.41.0+ are <c>net10.0</c>-only), and it
/// bundles Serialization 1.38.3 — so the 1.38.x divergences
/// <see cref="SpriggitDivergenceAllowlist"/> names are genuinely observable against it rather than
/// being untestable claims.</para>
///
/// <para><b>The ObjectTemplate canary (#385).</b> 0.40.1 bundles Mutagen 0.54.0-alpha.78, which
/// predates the <c>aa7cc540e</c> record-type-ordering regression of 2026-06-22
/// (<c>docs/research/mutagen-objecttemplate-0.54/root-cause.md</c>; fixed in 0.54.2). That is luck,
/// not design — a Spriggit version bundling a Mutagen between those two points would silently inflate
/// every FO4 weapon's <c>ObjectTemplates</c> and turn this oracle into a liar rather than a reference.
/// <see cref="SpriggitParityGateTests"/> asserts the counts explicitly instead of trusting the pin.</para>
/// </summary>
internal static class SpriggitOracle
{
    /// <summary>
    /// Absolute path to the installed tool executable. Install it with:
    /// <code>
    /// dotnet tool install --tool-path ~/.spriggit-oracle Spriggit.Json.Fallout4 --version 0.40.1
    /// export MEDIT_SPRIGGIT_TOOL=~/.spriggit-oracle/Spriggit.Json.Fallout4
    /// </code>
    /// </summary>
    internal const string ToolPathVariable = "MEDIT_SPRIGGIT_TOOL";

    internal static string? ToolPath
    {
        get
        {
            var configured = Environment.GetEnvironmentVariable(ToolPathVariable);
            return string.IsNullOrWhiteSpace(configured) || !File.Exists(configured) ? null : configured;
        }
    }

    /// <summary>
    /// Marks a test skipped (not passed, and not failed) when the Spriggit toolchain is absent —
    /// #455 AC3. The same shape as <c>RealInstallSmokeTests.SmokeFactAttribute</c>: an honest
    /// "skipped" on a machine that cannot run it, rather than a green no-op.
    ///
    /// <para>A gate that is skipped everywhere is worth nothing, and this attribute is exactly the
    /// mechanism that would let that happen unnoticed. Making CI run it is tracked as #465 — this
    /// half of AC3 only promises that the gate skips cleanly and runs from one documented command.</para>
    /// </summary>
    internal sealed class SpriggitFactAttribute : FactAttribute
    {
        public SpriggitFactAttribute()
        {
            if (ToolPath is null)
            {
                Skip = $"Set {ToolPathVariable} to an installed Spriggit.Json.Fallout4 "
                    + $"{MEditService.Core.Source.SpriggitSource.CurrentVersion} executable to run the Spriggit parity gate.";
            }
        }
    }

    /// <summary>
    /// Serializes <paramref name="pluginPath"/> into <paramref name="outputDirectory"/> through the real
    /// tool and returns <b>the number of files it actually wrote</b>.
    ///
    /// <para>Returning a count, and refusing a zero one, is the whole point. "No differences found" from
    /// a comparison that enumerated nothing passes every check that is not looking for it, and an
    /// oracle that silently produces an empty directory is the shortest path to that failure. This
    /// throws rather than returning 0, so no caller can be vacuously green even by forgetting to
    /// assert.</para>
    /// </summary>
    internal static int Serialize(string pluginPath, string outputDirectory, GameRelease release)
    {
        var tool = ToolPath
            ?? throw new InvalidOperationException($"{ToolPathVariable} is not set to an existing file.");

        Directory.CreateDirectory(outputDirectory);

        var start = new ProcessStartInfo(tool)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in new[]
                 {
                     "serialize",
                     "-i", pluginPath,
                     "-o", outputDirectory,
                     "-g", release.ToString(),
                     "-p", MEditService.Core.Source.SpriggitSource.CurrentPackageName,
                     "-v", MEditService.Core.Source.SpriggitSource.CurrentVersion,
                 })
        {
            start.ArgumentList.Add(argument);
        }

        using var process = Process.Start(start)
            ?? throw new InvalidOperationException($"Could not start '{tool}'.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(milliseconds: 10 * 60 * 1000))
        {
            process.Kill(entireProcessTree: true);
            throw new InvalidOperationException($"'{tool} serialize' did not finish within 10 minutes.");
        }

        if (process.ExitCode != 0)
            throw new InvalidOperationException($"'{tool} serialize' exited {process.ExitCode}.\n{stdout}\n{stderr}");

        var written = Directory.GetFiles(outputDirectory, "*", SearchOption.AllDirectories).Length;
        if (written == 0)
        {
            throw new InvalidOperationException(
                $"'{tool} serialize' reported success but wrote no files to '{outputDirectory}'. "
                + $"That is the vacuous-oracle failure this check exists to catch.\n{stdout}\n{stderr}");
        }

        return written;
    }
}
