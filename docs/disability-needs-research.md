# Disability Needs Evidence Review

Last reviewed: 4 August 2026

## Purpose

This document records the evidence behind Skin AI's first disability-focused matching capabilities. It answers one practical question:

> Which user-stated dressing barriers can the MVP match against observable garment facts without guessing that a product will suit a person?

This is a product evidence review, not clinical guidance. Published research can identify recurring barriers, but it cannot define every disabled person's needs. The application must ask users about their own functional requirements and must not infer them from a diagnosis.

## Decision summary

The MVP should support two closely related areas:

1. **Hand dexterity and grip:** match user requirements against documented fastening types and grip features.
2. **Reach, shoulder movement, and dressing method:** match user requirements against documented fastening locations and ways of putting on a garment.

Garment measurements can remain a separate supporting capability. Pain and fatigue are important reasons to reduce unsuitable try-ons, but they are not garment attributes that the system can verify. Seated fit, sensory requirements, and other needs should remain later research areas until the catalogue has suitable data and disabled users have helped test the vocabulary and matching rules.

## Product principles derived from the evidence

### Match functions, not diagnoses

People with the same diagnosis can have different movement, grip, dressing techniques, assistance, and preferences. A 2025 participatory study of people with upper-limb impairments or differences found substantial variation even among people whose impairments might appear similar. Participants described different needs for openings, adjustment, grip points, sleeves, pockets, and security ([Fashion Practice study](https://www.tandfonline.com/doi/full/10.1080/17569370.2025.2515865)).

Skin AI should therefore ask about a functional requirement such as “I need a front opening” or “I cannot use small buttons.” It should never translate a diagnosis directly into garment requirements.

### Do not assign universal accessibility scores

No fastening is always easiest for everyone. Fastener design and position affected dressing performance differently for different groups in an early user-oriented study ([Applied Ergonomics study](https://doi.org/10.1016/0003-6870(89)90130-0)). A more recent comparison found hook-and-loop and magnetic closures easier than a zipper for its small, specific participant group, but that result cannot be generalized to every disabled person ([Home Economics Journal study](https://doi.org/10.21831/hej.v9i1.85943)). Alternative fastenings can also introduce trade-offs such as coming undone under strain, as noted in occupational-therapy guidance collected by [Parkinson's UK](https://www.parkinsons.org.uk/sites/default/files/2018-09/B011%20Tips%20and%20hints%20for%20people%20with%20Parkinson%27s%20WEB.pdf).

The application should record garment facts and let the user say which facts are required, preferred, or unsuitable. It should not label a closure “accessible for disabled people.”

### Treat missing information as unknown

A product image or vague description does not prove fastening location, opening extent, or dressing method. Only explicit retailer data or reviewed textual evidence can confirm an accessibility-related attribute. Unknown values must stay `unknown`; they must not silently pass a hard compatibility check.

### Validate the design with disabled people

A systematic review of 51 adaptive-apparel studies found progress in user-centred methods but continuing gaps across disability types, methods, cultures, and social barriers ([International Journal of Consumer Studies review](https://doi.org/10.1111/ijcs.13057)). Participatory research also shows that disabled people hold detailed experiential knowledge about garment modifications and trade-offs ([upper-limb apparel study](https://www.tandfonline.com/doi/full/10.1080/17569370.2025.2515865)).

This review can define a safe prototype. It is not a substitute for compensated co-design and usability testing with disabled people before making broader claims.

## Evidence-to-capability map

| User-stated barrier | What the evidence supports | Observable catalogue facts | MVP decision |
| --- | --- | --- | --- |
| Small or difficult fastenings | Buttons, zippers, drawstrings, and belts can create grip and manipulation barriers. Larger zipper pulls, buttoning aids, hook-and-loop, and elastic are useful for some people ([qualitative clothing study](https://link.springer.com/article/10.1186/s40691-025-00425-y), [Arthritis Foundation guidance](https://www.arthritis.org/health-wellness/healthy-living/managing-pain/joint-protection/self-help-arthritis-devices)). | `closureType`, `gripFeature`, explicit fastening size or source text | **Include.** Match only the user's stated requirements; do not rank closure types universally. |
| Rear, side, or otherwise unreachable fastenings | Fastener position affects dressing performance. One-handed occupational-therapy guidance recommends front fastenings or alternatives for some users, while research shows the best location varies by functional group ([fastener-position study](https://doi.org/10.1016/0003-6870(89)90130-0), [NHS one-handed guidance](https://www.kingstonandrichmond.nhs.uk/patients-and-families/patient-leaflets/managing-tasks-home-using-one-hand)). | `closureLocation` | **Include.** Users choose required and excluded locations. |
| Difficulty pulling a garment overhead or stepping into it | Added openings, adjustable components, and extra grip points can support different donning and doffing techniques ([user-centred apparel case study](https://doi.org/10.1080/17569370.2022.2031011), [upper-limb apparel study](https://www.tandfonline.com/doi/full/10.1080/17569370.2025.2515865)). | `dressingMethod`, `openingExtent`, `closureLocation` | **Include cautiously.** Only use an explicit full opening, wrap, overhead, or step-in description. |
| One-handed dressing | NHS guidance describes avoiding hard-to-handle fastenings and considering elastic, hook-and-loop, or front fastenings, but the correct technique depends on the person's movement and clinical advice ([NHS one-handed guidance](https://www.kingstonandrichmond.nhs.uk/patients-and-families/patient-leaflets/managing-tasks-home-using-one-hand)). | Same facts as above | **Do not create a universal `oneHanded=true` label.** Match the person's stated closure and dressing-method requirements instead. |
| Pain, breathlessness, or fatigue during dressing and repeated try-ons | NHS energy-management advice recommends reducing effort through planning, sitting, limiting bending, and choosing clothes that are easier to put on ([NHS fatigue guidance](https://www.cpft.nhs.uk/post-covid-fatigue/), [NHS energy-conservation leaflet](https://website.ulh.nhs.uk/documents/patient_information_leaflets/2752%20Managing%20Fatigue%20and%20Conserving%20Energy%20v1.pdf)). | No reliable single garment field | **Benefit, not match claim.** The shortlist may reduce avoidable try-ons, but the product must not claim to measure or treat fatigue or pain. |
| Lower-body dressing and seated fit | Research with people with lower-limb disabilities found opening size, fastener, and opening position all mattered, with different results by impairment severity ([lower-body clothing study](https://doi.org/10.19398/j.att.202010008)). Wheelchair-oriented clothing research also evaluates garments specifically in seated use ([PubMed study](https://pubmed.ncbi.nlm.nih.gov/23948502/)). | Opening dimensions, rise, back length, seated cut, pressure points, access openings | **Later phase.** Ordinary retailer feeds rarely provide enough structured evidence, and a generic “wheelchair friendly” label would hide important differences. |
| Sensory or skin-related requirements | Clothing texture, seams, tags, fit, and the individual's response can matter; preferences may conflict, such as loose versus close-fitting clothing ([NHS paediatric occupational-therapy resource](https://www.wsh.nhs.uk/CMS-Documents/ICPS/OT/Dressing.pdf)). | Fabric composition, seam construction, tag construction, compression and finish | **Later phase.** Do not infer sensory comfort from an image or fabric name. This area needs more focused research and user validation. |
| Reachable pockets, sleeve adjustment, and garment control | Participants with upper-limb impairments described pocket reach, sleeve adjustment, loops, rings, and extra grip points as useful but highly individual features ([upper-limb apparel study](https://www.tandfonline.com/doi/full/10.1080/17569370.2025.2515865)). | Pocket location and opening, sleeve adjustment, grip loops | **Later extension.** Preserve source text now; add structured fields after co-design and catalogue testing. |

## Recommended MVP vocabulary

The vocabulary should describe garments, not people. These are preliminary values to test with disabled users and real retailer listings.

```text
closureType:
  none | zip | buttons | snaps | magnetic | hook_and_loop |
  wrap_tie | drawstring | buckle | hook_and_bar | unknown

closureLocation:
  front | side | back | shoulder | inseam | multiple | unknown

dressingMethod:
  full_front_opening | partial_front_opening | overhead |
  step_in | wrap | unknown

gripFeature:
  ring_pull | loop_pull | extended_tab | large_documented |
  none_documented | unknown

openingExtent:
  full | partial | unknown
```

Important distinctions:

- `pull-on` or `overhead` describes a dressing method, not a fastening type.
- `large_documented` may be used only when the retailer explicitly describes or measures the feature. It is not an objective size unless a measurement is supplied.
- `none_documented` means the source explicitly shows there is no added grip feature. An omitted detail is `unknown`.
- The schema should preserve the retailer's original wording alongside the normalized value.

Every value uses the evidence wrapper already defined for the catalogue:

```json
{
  "closureLocation": {
    "value": "front",
    "status": "manually_verified",
    "sourceText": "Full front zip with a large ring pull.",
    "sourceUrl": "https://retailer.example/product/123",
    "verifiedAt": "2026-08-04"
  }
}
```

## Matching rules implied by the research

1. The LLM translates the user's language into this fixed vocabulary, but its result is only a proposal.
2. The backend validates every proposed value against the approved enum and checks for contradictions.
3. Deterministic code compares the validated requirements with confirmed catalogue facts.
4. A hard requirement passes only when the relevant product fact is confirmed and compatible.
5. An `unknown` product fact is displayed as missing information, not as a match or conflict.
6. Preferences may rank confirmed matches, but they cannot override a confirmed conflict with a hard requirement.
7. Results explain the exact evidence used; they do not say “suitable for your disability” or guarantee fit.

Example:

> “Buttons are difficult and I cannot reach a back zip. I prefer something I can open fully at the front.”

The LLM may propose:

```json
{
  "requiredAccess": {
    "closureLocation": ["front"],
    "dressingMethod": ["full_front_opening"]
  },
  "excludedAccess": {
    "closureType": ["buttons"],
    "closureLocation": ["back"]
  }
}
```

The backend validates those values and searches the enriched catalogue. It does not search for a diagnosis and does not ask the LLM to decide whether a garment is accessible.

## Claims the MVP may and may not make

Acceptable:

- “This product has a retailer-documented full front zip.”
- “This product conflicts with your request to avoid back fastenings.”
- “The retailer did not provide enough information to verify the dressing method.”
- “This shortlist may reduce the number of unsuitable garments you need to try.”

Not acceptable:

- “This garment is accessible for disabled people.”
- “This will be easy for anyone with arthritis, Parkinson's, limb difference, or another diagnosis.”
- “This will fit you” based on a virtual image.
- “This reduces pain or fatigue” as a medical or guaranteed outcome.
- “This garment supports one-handed dressing” unless that exact claim has reliable evidence and is still presented as product evidence rather than a personal guarantee.

## Research and validation still required

Before expanding beyond the prototype:

1. Run compensated interviews and task-based usability tests with disabled participants who have varied dressing methods, grip, reach, pain, and fatigue experiences.
2. Ask participants to revise the vocabulary, especially `dressingMethod`, `gripFeature`, and the meaning of hard requirement versus preference.
3. Test whether real retailer descriptions provide enough evidence for each field and record how often each field remains `unknown`.
4. Test result explanations for clarity, screen-reader use, keyboard operation, cognitive load, and trust.
5. Review false matches and false exclusions with participants before changing deterministic rules.
6. Conduct separate evidence reviews before adding seated fit, sensory requirements, caregiver-assisted dressing, prosthesis or brace accommodation, skin integrity, or medical-access garments.

## Conclusion

The defensible first product is not an AI that decides what is “accessible.” It is a grounded matching system that lets a person state concrete dressing requirements, translates those requirements into a small controlled vocabulary, and compares them with verified garment facts. The narrow MVP should begin with fastenings, fastening location, dressing method, and grip features, while showing missing evidence honestly and leaving more complex areas for direct co-design and later research.
